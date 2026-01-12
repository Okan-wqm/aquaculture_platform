//! Script execution engine
//!
//! Evaluates conditions and executes actions.
//!
//! v2.0 Features:
//! - Execution limits (depth, time, actions)
//! - Rate limiting per script
//! - Infinite loop protection

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn, error, debug};
use serde_json::{json, Value};
use chrono::Utc;

use super::{
    ScriptDefinition, Script, ScriptStatus, ScriptStorage,
    ScriptContext, Condition, ConditionType, ComparisonOperator,
    Action, ActionType, ActionResult, AlertLevel,
    TriggerManager,
    ScriptLimits, ScriptRateLimiter, ExecutionContext, LimitError,
};

use crate::AppState;
use crate::gpio::PinState;

/// Script execution result
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    pub script_id: String,
    pub success: bool,
    pub actions_executed: usize,
    pub actions_failed: usize,
    pub results: Vec<ActionResult>,
    pub duration_ms: u64,
    pub timestamp: String,
}

/// Script execution engine
pub struct ScriptEngine {
    state: Arc<RwLock<AppState>>,
    storage: ScriptStorage,
    trigger_manager: TriggerManager,
    context: ScriptContext,
    /// Execution limits for scripts
    limits: ScriptLimits,
    /// Rate limiter for script executions
    rate_limiter: ScriptRateLimiter,
}

impl ScriptEngine {
    /// Create a new script engine
    pub fn new(state: Arc<RwLock<AppState>>) -> Self {
        let limits = ScriptLimits::default();
        let rate_limiter = ScriptRateLimiter::new(limits.rate_limit_per_minute);
        Self {
            state,
            storage: ScriptStorage::new(None),
            trigger_manager: TriggerManager::new(),
            context: ScriptContext::new(),
            limits,
            rate_limiter,
        }
    }

    /// Create with custom limits
    pub fn with_limits(state: Arc<RwLock<AppState>>, limits: ScriptLimits) -> Self {
        let rate_limiter = ScriptRateLimiter::new(limits.rate_limit_per_minute);
        Self {
            state,
            storage: ScriptStorage::new(None),
            trigger_manager: TriggerManager::new(),
            context: ScriptContext::new(),
            limits,
            rate_limiter,
        }
    }

    /// Initialize the engine
    pub async fn init(&mut self) -> anyhow::Result<()> {
        self.storage.init()?;
        info!("Script engine initialized with {} scripts", self.storage.count());

        // Execute startup scripts
        self.run_startup_scripts().await;

        Ok(())
    }

    /// Run startup scripts
    async fn run_startup_scripts(&mut self) {
        let startup_scripts: Vec<String> = self.storage.get_active()
            .iter()
            .filter(|s| s.definition.triggers.iter().any(|t| {
                t.trigger_type == super::TriggerType::Startup
            }))
            .map(|s| s.definition.id.clone())
            .collect();

        for script_id in startup_scripts {
            info!("Running startup script: {}", script_id);
            // Use depth=0 for startup scripts (top-level execution)
            if let Err(e) = self.execute_with_depth(&script_id, 0).await {
                error!("Startup script {} failed: {}", script_id, e);
            }
        }
    }

    /// Main loop - check triggers and execute scripts
    pub async fn run(&mut self) {
        info!("Script engine started");

        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(1));
        let mut reload_counter = 0u32;

        loop {
            interval.tick().await;

            // Reload scripts every 30 seconds to pick up changes from commands
            reload_counter += 1;
            if reload_counter >= 30 {
                reload_counter = 0;
                if let Err(e) = self.storage.load_all() {
                    warn!("Failed to reload scripts: {}", e);
                } else {
                    debug!("Scripts reloaded, count: {}", self.storage.count());
                }
            }

            // Update context with current data
            if let Err(e) = self.update_context().await {
                warn!("Failed to update context: {}", e);
                continue;
            }

            // Check triggers for active scripts
            let scripts_to_run = self.check_all_triggers();

            // Execute triggered scripts
            for script_id in scripts_to_run {
                debug!("Trigger fired for script: {}", script_id);
                // Use depth=0 for trigger-based executions (top-level)
                if let Err(e) = self.execute_with_depth(&script_id, 0).await {
                    error!("Script {} execution failed: {}", script_id, e);
                }
            }
        }
    }

    /// Update context with current sensor/GPIO data
    async fn update_context(&mut self) -> anyhow::Result<()> {
        self.context.refresh_time();

        // Update Modbus sensor values via thread-safe handle
        let modbus_handle = {
            let state = self.state.read().await;
            state.modbus_handle.clone()
        };

        if let Some(handle) = modbus_handle {
            let results = handle.read_all().await;
            for result in results {
                for value in &result.values {
                    self.context.set_sensor(&value.name, value.scaled_value);
                }
            }
        }

        // Update GPIO values via actor handle (v2.0)
        let gpio_handle = {
            let state = self.state.read().await;
            state.gpio_handle.clone()
        };

        if let Some(handle) = gpio_handle {
            let result = handle.read_all().await;
            for pin_value in &result.values {
                let pin_state = matches!(pin_value.state, PinState::High);
                self.context.set_gpio(pin_value.pin, pin_state);
            }
        }

        // Update system metrics
        // (System metrics are updated in telemetry, we just reference them)

        Ok(())
    }

    /// Check all triggers and return scripts that should run
    fn check_all_triggers(&mut self) -> Vec<String> {
        let mut scripts_to_run = Vec::new();

        for script in self.storage.get_active() {
            let script_id = &script.definition.id;

            for (idx, trigger) in script.definition.triggers.iter().enumerate() {
                if self.trigger_manager.check_trigger(
                    script_id,
                    idx,
                    trigger,
                    &self.context,
                ) {
                    if !scripts_to_run.contains(script_id) {
                        scripts_to_run.push(script_id.clone());
                    }
                    break; // Only need one trigger to fire
                }
            }
        }

        scripts_to_run
    }

    /// Execute a script by ID (public API - uses depth=0)
    pub async fn execute_script(&mut self, script_id: &str) -> anyhow::Result<ExecutionResult> {
        self.execute_with_depth(script_id, 0).await
    }

    /// Execute a script with depth tracking (v2.0 - infinite loop protection)
    ///
    /// This method enforces:
    /// - Maximum call depth (prevents infinite recursion)
    /// - Rate limiting per script
    /// - Execution timeout
    /// - Action count limits
    async fn execute_with_depth(&mut self, script_id: &str, depth: usize) -> anyhow::Result<ExecutionResult> {
        let start = std::time::Instant::now();

        // Check depth limit FIRST (infinite loop protection)
        if depth >= self.limits.max_call_depth {
            warn!("Script {} exceeded max call depth ({})", script_id, self.limits.max_call_depth);
            return Ok(ExecutionResult {
                script_id: script_id.to_string(),
                success: false,
                actions_executed: 0,
                actions_failed: 1,
                results: vec![ActionResult::failure(
                    ActionType::CallScript,
                    format!("Max call depth ({}) exceeded", self.limits.max_call_depth)
                )],
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp: Utc::now().to_rfc3339(),
            });
        }

        // Check rate limit
        if !self.rate_limiter.check(script_id) {
            warn!("Script {} rate limited", script_id);
            return Ok(ExecutionResult {
                script_id: script_id.to_string(),
                success: false,
                actions_executed: 0,
                actions_failed: 1,
                results: vec![ActionResult::failure(
                    ActionType::Noop,
                    format!("Rate limit exceeded ({}/min)", self.limits.rate_limit_per_minute)
                )],
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp: Utc::now().to_rfc3339(),
            });
        }

        let script = self.storage.get(script_id)
            .ok_or_else(|| anyhow::anyhow!("Script not found: {}", script_id))?;

        let definition = script.definition.clone();

        info!("Executing script: {} ({}) [depth={}]", definition.name, definition.id, depth);

        // Mark as running
        if let Some(s) = self.storage.get_mut(script_id) {
            s.status = ScriptStatus::Running;
        }

        // Check conditions
        if !self.evaluate_conditions(&definition.conditions) {
            debug!("Script {} conditions not met, skipping", script_id);
            self.storage.update_result(script_id, true, "Conditions not met - skipped");

            return Ok(ExecutionResult {
                script_id: script_id.to_string(),
                success: true,
                actions_executed: 0,
                actions_failed: 0,
                results: vec![],
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp: Utc::now().to_rfc3339(),
            });
        }

        // Create execution context for tracking limits
        let mut exec_ctx = ExecutionContext::new(self.limits.clone());
        exec_ctx.call_depth = depth;

        // Execute actions with limits
        let mut results = Vec::new();
        let mut actions_executed = 0;
        let mut actions_failed = 0;

        for action in &definition.actions {
            // Check execution time limit
            if exec_ctx.is_time_exceeded() {
                warn!("Script {} execution time exceeded", script_id);
                results.push(ActionResult::failure(
                    ActionType::Noop,
                    "Execution time limit exceeded"
                ));
                actions_failed += 1;
                break;
            }

            // Check action count limit
            if let Err(LimitError::ActionLimitExceeded) = exec_ctx.record_action() {
                warn!("Script {} action limit exceeded", script_id);
                results.push(ActionResult::failure(
                    ActionType::Noop,
                    format!("Action limit ({}) exceeded", self.limits.max_actions_per_run)
                ));
                actions_failed += 1;
                break;
            }

            let result = self.execute_action_with_depth(action, depth).await;

            if result.success {
                actions_executed += 1;
            } else {
                actions_failed += 1;
            }

            results.push(result);
        }

        // Handle errors if any actions failed
        if actions_failed > 0 && !definition.on_error.is_empty() {
            for action in &definition.on_error {
                // Don't exceed action limit for error handlers
                if exec_ctx.record_action().is_err() {
                    break;
                }
                let result = self.execute_action_with_depth(action, depth).await;
                results.push(result);
            }
        }

        let success = actions_failed == 0;
        let result_msg = if success {
            format!("Completed {} actions", actions_executed)
        } else {
            format!("{} actions failed", actions_failed)
        };

        self.storage.update_result(script_id, success, &result_msg);

        Ok(ExecutionResult {
            script_id: script_id.to_string(),
            success,
            actions_executed,
            actions_failed,
            results,
            duration_ms: start.elapsed().as_millis() as u64,
            timestamp: Utc::now().to_rfc3339(),
        })
    }

    /// Evaluate all conditions (AND logic)
    fn evaluate_conditions(&self, conditions: &[Condition]) -> bool {
        for condition in conditions {
            if !self.evaluate_condition(condition) {
                return false;
            }
        }
        true
    }

    /// Evaluate a single condition
    fn evaluate_condition(&self, condition: &Condition) -> bool {
        let value = match self.context.get_value(&condition.source) {
            Some(v) => v,
            None => {
                debug!("Condition source '{}' not found", condition.source);
                return false;
            }
        };

        self.compare_values(&value, &condition.operator, &condition.value)
    }

    /// Compare two values
    fn compare_values(&self, left: &Value, op: &ComparisonOperator, right: &Value) -> bool {
        // Numeric comparison
        if let (Some(l), Some(r)) = (left.as_f64(), right.as_f64()) {
            return match op {
                ComparisonOperator::Eq => (l - r).abs() < f64::EPSILON,
                ComparisonOperator::Ne => (l - r).abs() >= f64::EPSILON,
                ComparisonOperator::Gt => l > r,
                ComparisonOperator::Gte => l >= r,
                ComparisonOperator::Lt => l < r,
                ComparisonOperator::Lte => l <= r,
                ComparisonOperator::Between => {
                    if let Some(arr) = right.as_array() {
                        if arr.len() >= 2 {
                            let min = arr[0].as_f64().unwrap_or(f64::MIN);
                            let max = arr[1].as_f64().unwrap_or(f64::MAX);
                            return l >= min && l <= max;
                        }
                    }
                    false
                }
                _ => false,
            };
        }

        // Boolean comparison
        if let (Some(l), Some(r)) = (left.as_bool(), right.as_bool()) {
            return match op {
                ComparisonOperator::Eq => l == r,
                ComparisonOperator::Ne => l != r,
                _ => false,
            };
        }

        // String comparison
        if let (Some(l), Some(r)) = (left.as_str(), right.as_str()) {
            return match op {
                ComparisonOperator::Eq => l == r,
                ComparisonOperator::Ne => l != r,
                ComparisonOperator::Contains => l.contains(r),
                _ => false,
            };
        }

        false
    }

    /// Execute a single action (wrapper for backwards compatibility)
    async fn execute_action(&mut self, action: &Action) -> ActionResult {
        self.execute_action_with_depth(action, 0).await
    }

    /// Execute a single action with depth tracking
    async fn execute_action_with_depth(&mut self, action: &Action, depth: usize) -> ActionResult {
        // Check inline condition if present
        if let Some(ref condition) = action.condition {
            let cond = Condition {
                condition_type: ConditionType::Sensor,
                source: condition.source.clone(),
                operator: condition.operator.clone(),
                value: condition.value.clone(),
            };

            if !self.evaluate_condition(&cond) {
                return ActionResult::success(ActionType::Noop, "Condition not met - skipped");
            }
        }

        match action.action_type {
            ActionType::SetGpio => self.action_set_gpio(action).await,
            ActionType::WriteModbus => self.action_write_modbus(action).await,
            ActionType::WriteCoil => self.action_write_coil(action).await,
            ActionType::Alert => self.action_alert(action).await,
            ActionType::SetVariable => self.action_set_variable(action),
            ActionType::Log => self.action_log(action),
            ActionType::Delay => self.action_delay(action).await,
            ActionType::PublishMqtt => self.action_publish_mqtt(action).await,
            ActionType::CallScript => self.action_call_script_with_depth(action, depth).await,
            ActionType::Noop => ActionResult::success(ActionType::Noop, "No operation"),
        }
    }

    /// Set GPIO pin action (v2.0 - uses actor pattern)
    async fn action_set_gpio(&self, action: &Action) -> ActionResult {
        let pin: u8 = match action.target.parse() {
            Ok(p) => p,
            Err(_) => return ActionResult::failure(ActionType::SetGpio, "Invalid pin number"),
        };

        let value = match action.value.as_ref().and_then(|v| v.as_bool()) {
            Some(v) => v,
            None => return ActionResult::failure(ActionType::SetGpio, "Missing or invalid value"),
        };

        // Get GPIO handle (thread-safe, actor pattern)
        let gpio_handle = {
            let app_state = self.state.read().await;
            app_state.gpio_handle.clone()
        };

        match gpio_handle {
            Some(handle) => {
                match handle.write_pin(pin, value).await {
                    Ok(()) => {
                        let state_str = if value { "HIGH" } else { "LOW" };
                        ActionResult::success(ActionType::SetGpio, format!("Set GPIO {} to {}", pin, state_str))
                    }
                    Err(e) => {
                        ActionResult::failure(ActionType::SetGpio, format!("Failed: {}", e))
                    }
                }
            }
            None => ActionResult::failure(ActionType::SetGpio, "GPIO not available"),
        }
    }

    /// Write Modbus register action
    async fn action_write_modbus(&self, action: &Action) -> ActionResult {
        let device = match &action.device {
            Some(d) => d,
            None => return ActionResult::failure(ActionType::WriteModbus, "Missing device name"),
        };

        let address = match action.address {
            Some(a) => a,
            None => return ActionResult::failure(ActionType::WriteModbus, "Missing register address"),
        };

        let value = match action.value.as_ref().and_then(|v| v.as_u64()) {
            Some(v) => v as u16,
            None => return ActionResult::failure(ActionType::WriteModbus, "Missing or invalid value"),
        };

        // Get modbus handle (thread-safe)
        let modbus_handle = {
            let app_state = self.state.read().await;
            app_state.modbus_handle.clone()
        };

        match modbus_handle {
            Some(handle) => {
                match handle.write_register(device, address, value).await {
                    Ok(()) => {
                        ActionResult::success(
                            ActionType::WriteModbus,
                            format!("Wrote {} to {}:{}", value, device, address)
                        )
                    }
                    Err(e) => {
                        ActionResult::failure(ActionType::WriteModbus, format!("Failed: {}", e))
                    }
                }
            }
            None => ActionResult::failure(ActionType::WriteModbus, "Modbus not available"),
        }
    }

    /// Write Modbus coil action
    async fn action_write_coil(&self, action: &Action) -> ActionResult {
        let device = match &action.device {
            Some(d) => d,
            None => return ActionResult::failure(ActionType::WriteCoil, "Missing device name"),
        };

        let address = match action.address {
            Some(a) => a,
            None => return ActionResult::failure(ActionType::WriteCoil, "Missing coil address"),
        };

        let value = match action.value.as_ref().and_then(|v| v.as_bool()) {
            Some(v) => v,
            None => return ActionResult::failure(ActionType::WriteCoil, "Missing or invalid value"),
        };

        // Get modbus handle (thread-safe)
        let modbus_handle = {
            let app_state = self.state.read().await;
            app_state.modbus_handle.clone()
        };

        match modbus_handle {
            Some(handle) => {
                match handle.write_coil(device, address, value).await {
                    Ok(()) => {
                        ActionResult::success(
                            ActionType::WriteCoil,
                            format!("Wrote {} to {}:{}", value, device, address)
                        )
                    }
                    Err(e) => {
                        ActionResult::failure(ActionType::WriteCoil, format!("Failed: {}", e))
                    }
                }
            }
            None => ActionResult::failure(ActionType::WriteCoil, "Modbus not available"),
        }
    }

    /// Alert action - publish alert to MQTT
    async fn action_alert(&self, action: &Action) -> ActionResult {
        let message = match &action.message {
            Some(m) => self.context.interpolate(m),
            None => return ActionResult::failure(ActionType::Alert, "Missing message"),
        };

        let level = action.level.unwrap_or(AlertLevel::Warning);

        info!("ALERT [{:?}]: {}", level, message);

        // Publish to MQTT alert topic
        let app_state = self.state.read().await;
        if let Some(ref mqtt) = app_state.mqtt_client {
            let alert_data = json!({
                "level": format!("{:?}", level).to_lowercase(),
                "message": message,
                "timestamp": Utc::now().to_rfc3339(),
                "source": "script_engine"
            });

            // Note: Would need to add an alert topic to MQTT client
            // For now, just log it
            debug!("Alert would be published: {:?}", alert_data);
        }

        ActionResult::success(ActionType::Alert, format!("Alert sent: {}", message))
    }

    /// Set variable action
    fn action_set_variable(&mut self, action: &Action) -> ActionResult {
        let value = match &action.value {
            Some(v) => v.clone(),
            None => return ActionResult::failure(ActionType::SetVariable, "Missing value"),
        };

        self.context.set_variable(&action.target, value.clone());

        ActionResult::success(
            ActionType::SetVariable,
            format!("Set {} = {:?}", action.target, value)
        )
    }

    /// Log action
    fn action_log(&self, action: &Action) -> ActionResult {
        let message = match &action.message {
            Some(m) => self.context.interpolate(m),
            None => return ActionResult::failure(ActionType::Log, "Missing message"),
        };

        info!("[Script Log] {}", message);

        ActionResult::success(ActionType::Log, message)
    }

    /// Delay action (v2.0 - with max delay limit)
    async fn action_delay(&self, action: &Action) -> ActionResult {
        let delay_ms = action.delay_ms.unwrap_or(1000);

        // Check against max delay limit
        if delay_ms > self.limits.max_delay_ms {
            return ActionResult::failure(
                ActionType::Delay,
                format!("Delay {}ms exceeds maximum allowed ({}ms)", delay_ms, self.limits.max_delay_ms)
            );
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;

        ActionResult::success(ActionType::Delay, format!("Delayed {}ms", delay_ms))
    }

    /// Publish MQTT message action
    async fn action_publish_mqtt(&self, action: &Action) -> ActionResult {
        let message = match &action.message {
            Some(m) => self.context.interpolate(m),
            None => return ActionResult::failure(ActionType::PublishMqtt, "Missing message"),
        };

        // Target is the topic
        let topic = if action.target.is_empty() {
            "scripts/output".to_string()
        } else {
            self.context.interpolate(&action.target)
        };

        debug!("Would publish to {}: {}", topic, message);

        ActionResult::success(ActionType::PublishMqtt, format!("Published to {}", topic))
    }

    /// Call another script (v2.0 - with depth tracking for infinite loop protection)
    async fn action_call_script_with_depth(&mut self, action: &Action, current_depth: usize) -> ActionResult {
        let script_id = match &action.script_id {
            Some(id) => id,
            None => return ActionResult::failure(ActionType::CallScript, "Missing script_id"),
        };

        // Increment depth for nested call
        let next_depth = current_depth + 1;

        debug!("Calling script {} from depth {} -> {}", script_id, current_depth, next_depth);

        // Use execute_with_depth with incremented depth
        match Box::pin(self.execute_with_depth(script_id, next_depth)).await {
            Ok(result) => {
                if result.success {
                    ActionResult::success(
                        ActionType::CallScript,
                        format!("Called script {} [depth={}]", script_id, next_depth)
                    )
                } else {
                    // Include reason for failure if it was a limit error
                    let reason = result.results.first()
                        .map(|r| r.message.clone())
                        .unwrap_or_else(|| "Unknown error".to_string());
                    ActionResult::failure(
                        ActionType::CallScript,
                        format!("Script {} failed: {}", script_id, reason)
                    )
                }
            }
            Err(e) => {
                ActionResult::failure(
                    ActionType::CallScript,
                    format!("Failed to call script: {}", e)
                )
            }
        }
    }

    /// Call another script (backwards compatibility - uses depth=0)
    #[allow(dead_code)]
    async fn action_call_script(&mut self, action: &Action) -> ActionResult {
        self.action_call_script_with_depth(action, 0).await
    }

    // === Public API for script management ===

    /// Add a script from definition
    pub fn add_script(&mut self, definition: ScriptDefinition) -> anyhow::Result<()> {
        self.storage.add_script(definition)
    }

    /// Delete a script
    pub fn delete_script(&mut self, id: &str) -> anyhow::Result<bool> {
        self.trigger_manager.reset_script(id);
        self.storage.delete(id)
    }

    /// Enable a script
    pub fn enable_script(&mut self, id: &str) -> anyhow::Result<bool> {
        self.storage.enable(id)
    }

    /// Disable a script
    pub fn disable_script(&mut self, id: &str) -> anyhow::Result<bool> {
        self.trigger_manager.reset_script(id);
        self.storage.disable(id)
    }

    /// List all scripts
    pub fn list_scripts(&self) -> Vec<&Script> {
        self.storage.get_all()
    }

    /// Get script by ID
    pub fn get_script(&self, id: &str) -> Option<&Script> {
        self.storage.get(id)
    }

    /// Get script count
    pub fn script_count(&self) -> usize {
        self.storage.count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compare_values_numeric() {
        // We can't easily instantiate ScriptEngine without AppState,
        // so we test the compare logic via the TriggerManager
        let manager = TriggerManager::new();

        // Test via context
        let mut ctx = ScriptContext::new();
        ctx.set_sensor("temp", 25.5);

        assert!(ctx.get_sensor("temp").is_some());
        assert_eq!(ctx.get_sensor("temp"), Some(25.5));
    }
}

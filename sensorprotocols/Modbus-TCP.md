# Modbus TCP - Endüstriyel/SCADA Yapı Konfigürasyonu

## Mevcut Alanlar (✅)
- IP Address
- Port
- Unit ID (Slave ID)
- Timeout (ms)
- Register Address
- Register Count
- Function Code

---

## EKSİK ALANLAR VE AÇIKLAMALARI

### 1. CONNECTION MANAGEMENT

#### Connection Type
- **Tip:** Dropdown
- **Seçenekler:**
  - Persistent (Keep-Alive) - Bağlantıyı açık tut
  - Per-Request - Her istekte yeni bağlantı
  - Connection Pool - Bağlantı havuzu
- **Default:** Persistent
- **Açıklama:** Endüstriyel sistemlerde persistent connection önerili

#### Keep-Alive Settings
```javascript
{
  "enabled": true,
  "idleTimeout": 60000,        // ms - bağlantı boştayken timeout
  "keepAliveInterval": 10000,  // ms - keep-alive paketi gönder
  "maxIdleTime": 300000        // ms - max boş kalma süresi
}
```

#### Auto Reconnect
```javascript
{
  "enabled": true,
  "reconnectDelay": 5000,      // ms - ilk deneme
  "maxReconnectDelay": 60000,  // ms - max bekleme
  "reconnectAttempts": 0,      // 0 = sonsuz
  "backoffMultiplier": 2.0     // Exponential backoff
}
```

#### Connection Timeout
- **Tip:** Number (ms)
- **Default:** 5000ms
- **Range:** 1000-60000ms
- **Açıklama:** İlk bağlantı kurma timeout'u (mevcut "Timeout"dan farklı)

---

### 2. MODBUS FUNCTION CODES (Genişletilmiş)

#### Mevcut Function Code (✅)
Sadece bir function code seçimi var, genişletilmeli:

#### Tüm Modbus Function Codes
```javascript
// READ Functions
FC01 = 0x01  // Read Coils (Digital Outputs)
FC02 = 0x02  // Read Discrete Inputs (Digital Inputs)
FC03 = 0x03  // Read Holding Registers (Analog Outputs)
FC04 = 0x04  // Read Input Registers (Analog Inputs)

// WRITE Functions
FC05 = 0x05  // Write Single Coil
FC06 = 0x06  // Write Single Register
FC15 = 0x0F  // Write Multiple Coils
FC16 = 0x10  // Write Multiple Registers

// READ/WRITE Combination
FC23 = 0x17  // Read/Write Multiple Registers

// DIAGNOSTIC Functions
FC07 = 0x07  // Read Exception Status
FC08 = 0x08  // Diagnostics
FC11 = 0x0B  // Get Comm Event Counter
FC12 = 0x0C  // Get Comm Event Log
FC17 = 0x11  // Report Slave ID
FC43 = 0x2B  // Read Device Identification
```

**UI Önerisi:**
```javascript
functionCodes: {
  read: [
    { code: 1, name: "Read Coils (FC01)", dataType: "boolean" },
    { code: 2, name: "Read Discrete Inputs (FC02)", dataType: "boolean" },
    { code: 3, name: "Read Holding Registers (FC03)", dataType: "register" },
    { code: 4, name: "Read Input Registers (FC04)", dataType: "register" }
  ],
  write: [
    { code: 5, name: "Write Single Coil (FC05)", dataType: "boolean" },
    { code: 6, name: "Write Single Register (FC06)", dataType: "register" },
    { code: 15, name: "Write Multiple Coils (FC15)", dataType: "boolean" },
    { code: 16, name: "Write Multiple Registers (FC16)", dataType: "register" }
  ]
}
```

---

### 3. REGISTER CONFIGURATION (Gelişmiş)

#### Register Mapping
```javascript
{
  "registers": [
    {
      "name": "Tank_Temperature",
      "address": 40001,              // Modbus address
      "functionCode": 3,
      "dataType": "FLOAT32",
      "byteOrder": "ABCD",
      "scaling": {
        "factor": 0.1,
        "offset": 0,
        "unit": "°C"
      },
      "range": {
        "min": 0,
        "max": 50
      },
      "alarms": [
        { "type": "high", "threshold": 28, "severity": "warning" },
        { "type": "critical_high", "threshold": 30, "severity": "critical" }
      ]
    },
    {
      "name": "Pump_Speed",
      "address": 40010,
      "functionCode": 3,
      "dataType": "UINT16",
      "byteOrder": "AB",
      "scaling": {
        "factor": 1,
        "unit": "RPM"
      },
      "writable": true,
      "writeAddress": 40010,
      "writeFunctionCode": 6
    }
  ]
}
```

#### Data Types (Kritik!)
```javascript
dataTypes: {
  // 16-bit (1 register)
  "INT16": {
    "size": 1,
    "signed": true,
    "range": [-32768, 32767]
  },
  "UINT16": {
    "size": 1,
    "signed": false,
    "range": [0, 65535]
  },
  
  // 32-bit (2 registers)
  "INT32": {
    "size": 2,
    "signed": true,
    "range": [-2147483648, 2147483647]
  },
  "UINT32": {
    "size": 2,
    "signed": false,
    "range": [0, 4294967295]
  },
  "FLOAT32": {
    "size": 2,
    "signed": true,
    "ieee754": true
  },
  
  // 64-bit (4 registers)
  "INT64": { "size": 4, "signed": true },
  "UINT64": { "size": 4, "signed": false },
  "FLOAT64": { "size": 4, "ieee754": true },
  
  // String types
  "STRING": {
    "size": "variable",
    "encoding": "ASCII" // ASCII, UTF-8, UTF-16
  },
  
  // Boolean (1 coil/bit)
  "BOOL": { "size": "1bit" },
  
  // BCD (Binary Coded Decimal)
  "BCD16": { "size": 1 },
  "BCD32": { "size": 2 }
}
```

#### Byte Order / Word Order (Endianness)
```javascript
byteOrders: {
  // 16-bit (1 register = 2 bytes)
  "AB": "Big Endian (Motorola)",      // [HI] [LO]
  "BA": "Little Endian (Intel)",      // [LO] [HI]
  
  // 32-bit (2 registers = 4 bytes)
  "ABCD": "Big Endian",               // [HI_HI] [HI_LO] [LO_HI] [LO_LO]
  "DCBA": "Little Endian",            // [LO_LO] [LO_HI] [HI_LO] [HI_HI]
  "BADC": "Mid-Big Endian",           // [HI_LO] [HI_HI] [LO_LO] [LO_HI]
  "CDAB": "Mid-Little Endian",        // [LO_HI] [LO_LO] [HI_HI] [HI_LO]
  
  // 64-bit
  "ABCDEFGH": "Big Endian",
  "HGFEDCBA": "Little Endian"
}
```

**ÖNEMLİ:** Endianness PLC/cihaz üreticisine göre değişir:
- Siemens: Big Endian (ABCD)
- Allen-Bradley/Rockwell: Little Endian (DCBA)
- Schneider Electric: Big Endian (ABCD)
- Mitsubishi: Varies (cihaza göre)

#### Scaling & Conversion
```javascript
{
  "scaling": {
    "enabled": true,
    "formula": "linear",          // linear, polynomial, custom
    "factor": 0.1,                // Raw value * factor
    "offset": 0,                  // + offset
    "decimals": 2,                // Yuvarlama
    "unit": "°C"
  },
  
  // Örnek: Raw value = 255 → (255 * 0.1) + 0 = 25.5°C
  
  // Custom formula
  "customFormula": "Math.sqrt(x * 100) / 10",
  
  // Lookup table (non-linear conversion)
  "lookupTable": [
    { "raw": 0, "value": 0 },
    { "raw": 100, "value": 10 },
    { "raw": 500, "value": 55 },
    { "raw": 1000, "value": 100 }
  ]
}
```

---

### 4. MULTIPLE SLAVE DEVICES (Kritik!)

#### Device List
```javascript
{
  "devices": [
    {
      "id": "plc_tank01",
      "name": "Tank 01 PLC",
      "ipAddress": "192.168.1.100",
      "port": 502,
      "unitId": 1,
      "enabled": true,
      "description": "Main tank control PLC"
    },
    {
      "id": "vfd_pump01",
      "name": "Pump 01 VFD",
      "ipAddress": "192.168.1.101",
      "port": 502,
      "unitId": 1,
      "enabled": true,
      "description": "Circulation pump frequency drive"
    },
    {
      "id": "io_module_sensors",
      "name": "Sensor I/O Module",
      "ipAddress": "192.168.1.102",
      "port": 502,
      "unitId": 2,
      "enabled": true
    }
  ]
}
```

#### Device Groups
```javascript
{
  "deviceGroups": [
    {
      "name": "Tank 01 System",
      "devices": ["plc_tank01", "vfd_pump01", "io_module_sensors"],
      "pollingInterval": 1000,
      "enabled": true
    },
    {
      "name": "Tank 02 System",
      "devices": ["plc_tank02", "vfd_pump02"],
      "pollingInterval": 1000,
      "enabled": true
    }
  ]
}
```

---

### 5. POLLING & SCHEDULING

#### Polling Configuration
```javascript
{
  "polling": {
    "enabled": true,
    "mode": "cyclic",             // cyclic, on-change, on-demand
    "interval": 1000,             // ms - default interval
    "priority": "high",           // high, normal, low
    
    // Adaptive polling
    "adaptive": {
      "enabled": true,
      "minInterval": 500,         // ms
      "maxInterval": 5000,        // ms
      "increaseOn": "stable",     // Value değişmediğinde artır
      "decreaseOn": "changing"    // Value değiştiğinde azalt
    },
    
    // Time-based scheduling
    "schedule": [
      {
        "days": ["monday", "tuesday", "wednesday", "thursday", "friday"],
        "startTime": "06:00",
        "endTime": "22:00",
        "interval": 1000           // Business hours: 1s
      },
      {
        "days": ["saturday", "sunday"],
        "interval": 5000           // Weekend: 5s
      },
      {
        "startTime": "22:00",
        "endTime": "06:00",
        "interval": 10000          // Night: 10s
      }
    ]
  }
}
```

#### Register Groups (Batch Reading)
```javascript
{
  "registerGroups": [
    {
      "name": "Temperature_Sensors",
      "registers": [
        { "address": 40001, "count": 1 },
        { "address": 40002, "count": 1 },
        { "address": 40003, "count": 1 }
      ],
      "pollingInterval": 1000,
      "priority": "critical"
    },
    {
      "name": "Pump_Status",
      "registers": [
        { "address": 40100, "count": 10 }
      ],
      "pollingInterval": 2000,
      "priority": "high"
    },
    {
      "name": "Non_Critical_Status",
      "registers": [
        { "address": 40500, "count": 20 }
      ],
      "pollingInterval": 10000,
      "priority": "low"
    }
  ]
}
```

#### Bulk Read Optimization
```javascript
{
  "bulkRead": {
    "enabled": true,
    "maxGap": 10,                 // Max 10 register boşluk birleştir
    "maxRegistersPerRead": 125,   // Modbus spec max
    "splitLargeRequests": true
  }
}
```

**Örnek:**
```
İstenen: 40001, 40002, 40003, 40015, 40016
Optimize edilmiş: 
  - Read 40001-40003 (3 registers)
  - Read 40015-40016 (2 registers)
  
Eğer maxGap=15 ise:
  - Read 40001-40016 (16 registers, tek istekte)
```

---

### 6. WRITE OPERATIONS

#### Write Configuration
```javascript
{
  "writeEnabled": true,
  "writeMode": "manual",          // manual, scheduled, triggered
  "confirmBeforeWrite": true,     // UI'da onay iste
  "readbackVerification": true,   // Yazılan değeri oku ve doğrula
  "writeRetries": 3,
  
  "writes": [
    {
      "name": "Set_Pump_Speed",
      "address": 40010,
      "functionCode": 6,          // Write Single Register
      "dataType": "UINT16",
      "value": 1500,              // RPM
      "conditions": [
        {
          "register": "Pump_Running",
          "operator": "==",
          "value": true,
          "message": "Pump must be running"
        }
      ]
    },
    {
      "name": "Enable_Feeder",
      "address": 00001,           // Coil address
      "functionCode": 5,          // Write Single Coil
      "value": true
    }
  ]
}
```

#### Write Scheduling
```javascript
{
  "scheduledWrites": [
    {
      "name": "Night_Mode_Pumps",
      "cronExpression": "0 22 * * *",  // Her gün 22:00
      "operations": [
        { "address": 40010, "value": 1000 },  // Pump speed 1000 RPM
        { "address": 40011, "value": 800 }
      ]
    }
  ]
}
```

#### Triggered Writes (Rule-based)
```javascript
{
  "triggeredWrites": [
    {
      "name": "Emergency_Stop_High_Temp",
      "trigger": {
        "register": "Tank_Temperature",
        "condition": "> 30",
        "hysteresis": 0.5          // Değer 29.5'in altına düşene kadar tetikleme
      },
      "actions": [
        {
          "address": 00100,        // Emergency stop coil
          "value": true,
          "functionCode": 5
        },
        {
          "webhook": "https://api.oceanfarm.com/alerts/emergency-stop"
        }
      ]
    }
  ]
}
```

---

### 7. ERROR HANDLING & DIAGNOSTICS

#### Modbus Exception Codes
```javascript
exceptionCodes: {
  0x01: "Illegal Function",
  0x02: "Illegal Data Address",
  0x03: "Illegal Data Value",
  0x04: "Slave Device Failure",
  0x05: "Acknowledge",
  0x06: "Slave Device Busy",
  0x08: "Memory Parity Error",
  0x0A: "Gateway Path Unavailable",
  0x0B: "Gateway Target Device Failed to Respond"
}
```

#### Error Handling Strategy
```javascript
{
  "errorHandling": {
    "onException": "retry",      // retry, skip, stop, fallback
    "onTimeout": "retry",
    "onConnectionLost": "reconnect",
    
    "retryPolicy": {
      "maxRetries": 3,
      "retryDelay": 100,         // ms
      "backoffType": "exponential",
      "retryOnExceptions": [0x04, 0x06], // Slave failure, busy
      "skipOnExceptions": [0x02, 0x03]   // Illegal address/value
    },
    
    "fallbackValue": {
      "enabled": true,
      "strategy": "last_known_good", // last_known_good, default, null
      "maxAge": 60000              // ms - max age of fallback value
    }
  }
}
```

#### Connection Health Monitoring
```javascript
{
  "healthCheck": {
    "enabled": true,
    "interval": 30000,           // ms
    "method": "ping",            // ping, read_register, diagnostic
    "testRegister": 40001,
    "failureThreshold": 3,       // 3 başarısız health check sonrası
    "actions": {
      "onUnhealthy": "reconnect",
      "notifyOnStatusChange": true
    }
  }
}
```

#### Statistics & Metrics
```javascript
{
  "statistics": {
    "enabled": true,
    "metrics": [
      "totalRequests",
      "successfulRequests",
      "failedRequests",
      "timeouts",
      "exceptions",
      "averageResponseTime",
      "maxResponseTime",
      "minResponseTime",
      "bytesTransferred",
      "lastSuccessTime",
      "uptime",
      "errorRate"
    ],
    
    "perDevice": true,           // Her cihaz için ayrı istatistik
    "perRegister": false,
    
    "alerts": [
      {
        "metric": "errorRate",
        "threshold": 0.1,        // 10% error rate
        "action": "notify"
      },
      {
        "metric": "averageResponseTime",
        "threshold": 1000,       // 1 second
        "action": "log_warning"
      }
    ]
  }
}
```

---

### 8. DATA VALIDATION & QUALITY

#### Range Validation
```javascript
{
  "validation": {
    "enabled": true,
    "rules": [
      {
        "register": "Tank_Temperature",
        "min": 0,
        "max": 50,
        "onOutOfRange": "clamp",  // clamp, reject, warn
        "notification": true
      },
      {
        "register": "pH_Level",
        "min": 6.0,
        "max": 9.0,
        "onOutOfRange": "reject"
      }
    ]
  }
}
```

#### Rate of Change Detection
```javascript
{
  "rateOfChange": {
    "enabled": true,
    "checks": [
      {
        "register": "Tank_Temperature",
        "maxChangePerSecond": 0.5,  // Max 0.5°C/s
        "action": "warn",
        "message": "Rapid temperature change detected"
      }
    ]
  }
}
```

#### Data Quality Flags
```javascript
{
  "qualityFlags": {
    "enabled": true,
    "flags": {
      "GOOD": "Value is valid and current",
      "UNCERTAIN": "Value is old or uncertain",
      "BAD": "Communication error or invalid",
      "STALE": "Value too old (based on polling interval)"
    },
    "staleTimeout": 5000         // ms - 2x polling interval
  }
}
```

---

### 9. ALARMS & NOTIFICATIONS

#### Alarm Configuration
```javascript
{
  "alarms": {
    "enabled": true,
    "levels": {
      "info": { "priority": 1, "color": "blue" },
      "warning": { "priority": 2, "color": "yellow" },
      "alarm": { "priority": 3, "color": "orange" },
      "critical": { "priority": 4, "color": "red" }
    },
    
    "rules": [
      {
        "name": "High_Temperature_Warning",
        "register": "Tank_Temperature",
        "condition": "> 28",
        "level": "warning",
        "hysteresis": 0.5,
        "deadband": 60000,         // ms - min time between alarms
        "actions": [
          {
            "type": "log",
            "message": "Temperature above 28°C"
          },
          {
            "type": "email",
            "to": ["operator@oceanfarm.com"]
          }
        ]
      },
      {
        "name": "Critical_Temperature",
        "register": "Tank_Temperature",
        "condition": "> 30",
        "level": "critical",
        "autoAcknowledge": false,  // Manual ack required
        "actions": [
          {
            "type": "webhook",
            "url": "https://api.oceanfarm.com/alerts/emergency"
          },
          {
            "type": "sms",
            "to": ["+4712345678"]
          },
          {
            "type": "write",
            "address": 00100,
            "value": true            // Emergency stop
          }
        ]
      }
    ]
  }
}
```

#### Alarm History
```javascript
{
  "alarmHistory": {
    "enabled": true,
    "maxRecords": 10000,
    "retention": 90,             // days
    "fields": [
      "timestamp",
      "alarmName",
      "level",
      "value",
      "message",
      "acknowledged",
      "acknowledgedBy",
      "acknowledgedAt"
    ]
  }
}
```

---

### 10. DATA LOGGING & HISTORIAN

#### Historical Data Storage
```javascript
{
  "historian": {
    "enabled": true,
    "storage": "timeseries",     // timeseries, database, file
    
    "dataPoints": [
      {
        "register": "Tank_Temperature",
        "storageMethod": "by_exception", // by_exception, on_change, periodic
        "deadband": 0.5,         // Only log if change > 0.5
        "maxInterval": 60000,    // Force log every 60s
        "compression": true
      },
      {
        "register": "Pump_Speed",
        "storageMethod": "on_change",
        "deadband": 10           // RPM
      }
    ],
    
    "database": {
      "type": "influxdb",        // influxdb, timescaledb, mongodb
      "host": "localhost",
      "port": 8086,
      "database": "oceanfarm",
      "retention": "30d"
    }
  }
}
```

#### Data Aggregation
```javascript
{
  "aggregation": {
    "enabled": true,
    "intervals": [
      {
        "period": "1m",
        "operations": ["min", "max", "avg"],
        "retention": "7d"
      },
      {
        "period": "1h",
        "operations": ["min", "max", "avg"],
        "retention": "90d"
      },
      {
        "period": "1d",
        "operations": ["min", "max", "avg"],
        "retention": "1y"
      }
    ]
  }
}
```

---

### 11. SECURITY

#### Network Security
```javascript
{
  "security": {
    "allowedIPs": [
      "192.168.1.0/24",
      "10.0.0.0/8"
    ],
    "blockedIPs": [],
    "requireVPN": false,
    
    "encryption": {
      "enabled": false,          // Standard Modbus TCP not encrypted
      "method": "TLS",           // Modbus TCP + TLS wrapper
      "certificate": "/path/to/cert.pem"
    }
  }
}
```

#### Access Control
```javascript
{
  "accessControl": {
    "enabled": true,
    "writeRequiresAuth": true,
    "readRequiresAuth": false,
    
    "roles": {
      "operator": {
        "read": ["*"],
        "write": ["40010-40050"]  // Sadece pump/valve control
      },
      "engineer": {
        "read": ["*"],
        "write": ["*"]
      },
      "viewer": {
        "read": ["*"],
        "write": []
      }
    }
  }
}
```

#### Audit Log
```javascript
{
  "auditLog": {
    "enabled": true,
    "logWrites": true,
    "logReads": false,
    "logExceptions": true,
    "logConfigChanges": true,
    
    "fields": [
      "timestamp",
      "user",
      "action",
      "device",
      "register",
      "oldValue",
      "newValue",
      "result"
    ],
    
    "storage": "database",
    "retention": 365            // days
  }
}
```

---

### 12. ADVANCED FEATURES

#### Modbus RTU over TCP
```javascript
{
  "protocol": "modbus-rtu-over-tcp",  // vs modbus-tcp
  "serialSettings": {
    "baudRate": 9600,
    "dataBits": 8,
    "parity": "none",          // none, even, odd
    "stopBits": 1
  }
}
```

#### Modbus Gateway
```javascript
{
  "gateway": {
    "enabled": true,
    "bridgeToRTU": {
      "enabled": true,
      "serialPort": "/dev/ttyUSB0",
      "devices": [
        { "unitId": 10, "description": "Legacy RTU sensor" }
      ]
    }
  }
}
```

#### OPC UA/DA Bridge
```javascript
{
  "opcBridge": {
    "enabled": true,
    "protocol": "OPC-UA",
    "endpoint": "opc.tcp://localhost:4840",
    "mapping": [
      {
        "modbusRegister": 40001,
        "opcNode": "ns=2;s=Tank01.Temperature"
      }
    ]
  }
}
```

#### MQTT Publishing
```javascript
{
  "mqttPublish": {
    "enabled": true,
    "broker": "mqtt://localhost:1883",
    "topics": [
      {
        "register": "Tank_Temperature",
        "topic": "oceanfarm/tank01/temperature",
        "qos": 1,
        "retain": true,
        "publishOnChange": true
      }
    ]
  }
}
```

---

### 13. REDUNDANCY & FAILOVER

#### Redundant Connections
```javascript
{
  "redundancy": {
    "enabled": true,
    "mode": "active-passive",   // active-passive, active-active
    
    "primary": {
      "ipAddress": "192.168.1.100",
      "port": 502
    },
    "secondary": {
      "ipAddress": "192.168.1.101",
      "port": 502
    },
    
    "failoverTrigger": {
      "consecutiveFailures": 3,
      "timeout": 5000
    },
    
    "fallbackDelay": 60000       // Wait before switching back to primary
  }
}
```

---

## ÖRNEK KONFİGÜRASYONLAR

### 1. Tank Temperature Monitoring (Single PLC)

```json
{
  "name": "Tank 01 Temperature & pH Monitoring",
  "enabled": true,
  
  "connection": {
    "ipAddress": "192.168.1.100",
    "port": 502,
    "unitId": 1,
    "connectionType": "persistent",
    "connectionTimeout": 5000,
    "keepAlive": {
      "enabled": true,
      "interval": 10000
    },
    "autoReconnect": {
      "enabled": true,
      "reconnectDelay": 5000,
      "maxReconnectAttempts": 0
    }
  },
  
  "polling": {
    "enabled": true,
    "interval": 1000,
    "mode": "cyclic"
  },
  
  "registers": [
    {
      "name": "Tank_Temperature",
      "address": 40001,
      "functionCode": 3,
      "count": 2,
      "dataType": "FLOAT32",
      "byteOrder": "ABCD",
      "scaling": {
        "factor": 1,
        "offset": 0,
        "decimals": 2,
        "unit": "°C"
      },
      "validation": {
        "min": 0,
        "max": 50
      },
      "alarms": [
        {
          "type": "warning",
          "condition": "> 28",
          "hysteresis": 0.5
        },
        {
          "type": "critical",
          "condition": "> 30",
          "hysteresis": 0.5
        }
      ]
    },
    {
      "name": "pH_Level",
      "address": 40003,
      "functionCode": 3,
      "count": 2,
      "dataType": "FLOAT32",
      "byteOrder": "ABCD",
      "scaling": {
        "factor": 1,
        "decimals": 2
      },
      "validation": {
        "min": 6.0,
        "max": 9.0
      },
      "alarms": [
        {
          "type": "warning",
          "condition": "< 7.0 || > 8.5"
        }
      ]
    },
    {
      "name": "Oxygen_Level",
      "address": 40005,
      "functionCode": 3,
      "count": 2,
      "dataType": "FLOAT32",
      "byteOrder": "ABCD",
      "scaling": {
        "factor": 1,
        "decimals": 2,
        "unit": "mg/L"
      },
      "alarms": [
        {
          "type": "critical",
          "condition": "< 6"
        }
      ]
    }
  ],
  
  "bulkRead": {
    "enabled": true,
    "maxGap": 10,
    "optimize": true
  },
  
  "historian": {
    "enabled": true,
    "storageMethod": "by_exception",
    "deadband": {
      "Tank_Temperature": 0.2,
      "pH_Level": 0.1,
      "Oxygen_Level": 0.3
    }
  },
  
  "mqttPublish": {
    "enabled": true,
    "broker": "mqtt://broker.oceanfarm.com:1883",
    "baseTopic": "oceanfarm/tank01",
    "publishOnChange": true,
    "qos": 1
  }
}
```

### 2. Multi-Device Pump Control System

```json
{
  "name": "Aquaculture Pump Control System",
  "enabled": true,
  
  "devices": [
    {
      "id": "vfd_pump01",
      "name": "Circulation Pump 01 VFD",
      "ipAddress": "192.168.1.101",
      "port": 502,
      "unitId": 1,
      "enabled": true
    },
    {
      "id": "vfd_pump02",
      "name": "Circulation Pump 02 VFD",
      "ipAddress": "192.168.1.102",
      "port": 502,
      "unitId": 1,
      "enabled": true
    },
    {
      "id": "vfd_pump03",
      "name": "Aeration Pump VFD",
      "ipAddress": "192.168.1.103",
      "port": 502,
      "unitId": 1,
      "enabled": true
    }
  ],
  
  "registerGroups": [
    {
      "name": "Pump_Status",
      "registers": [
        {
          "name": "Running_Status",
          "address": 0,
          "functionCode": 2,
          "dataType": "BOOL"
        },
        {
          "name": "Speed_Setpoint",
          "address": 40001,
          "functionCode": 3,
          "dataType": "UINT16",
          "scaling": { "unit": "RPM" },
          "writable": true,
          "writeFunctionCode": 6
        },
        {
          "name": "Speed_Actual",
          "address": 40002,
          "functionCode": 3,
          "dataType": "UINT16",
          "scaling": { "unit": "RPM" }
        },
        {
          "name": "Motor_Current",
          "address": 40010,
          "functionCode": 3,
          "dataType": "UINT16",
          "scaling": { "factor": 0.1, "unit": "A" }
        },
        {
          "name": "Alarm_Code",
          "address": 40020,
          "functionCode": 3,
          "dataType": "UINT16"
        }
      ],
      "pollingInterval": 1000,
      "applyToDevices": ["vfd_pump01", "vfd_pump02", "vfd_pump03"]
    }
  ],
  
  "scheduledWrites": [
    {
      "name": "Night_Mode",
      "cronExpression": "0 22 * * *",
      "operations": [
        {
          "device": "vfd_pump01",
          "address": 40001,
          "value": 1000,
          "description": "Reduce speed to 1000 RPM"
        },
        {
          "device": "vfd_pump02",
          "address": 40001,
          "value": 1000
        }
      ]
    },
    {
      "name": "Day_Mode",
      "cronExpression": "0 6 * * *",
      "operations": [
        {
          "device": "vfd_pump01",
          "address": 40001,
          "value": 1500,
          "description": "Increase speed to 1500 RPM"
        },
        {
          "device": "vfd_pump02",
          "address": 40001,
          "value": 1500
        }
      ]
    }
  ],
  
  "alarms": [
    {
      "name": "Pump_Alarm",
      "register": "Alarm_Code",
      "condition": "!= 0",
      "level": "alarm",
      "actions": [
        {
          "type": "log",
          "message": "VFD alarm code: {{value}}"
        },
        {
          "type": "webhook",
          "url": "https://api.oceanfarm.com/alerts/vfd-alarm"
        }
      ]
    },
    {
      "name": "High_Motor_Current",
      "register": "Motor_Current",
      "condition": "> 50",
      "level": "warning",
      "hysteresis": 5
    }
  ]
}
```

### 3. Comprehensive SCADA System

```json
{
  "name": "OceanFarm SCADA System",
  "description": "Complete aquaculture facility monitoring and control",
  
  "devices": [
    {
      "id": "main_plc",
      "name": "Main PLC - Siemens S7-1200",
      "ipAddress": "192.168.1.10",
      "port": 502,
      "unitId": 1,
      "deviceType": "PLC",
      "manufacturer": "Siemens"
    },
    {
      "id": "io_module_tank01",
      "name": "Tank 01 I/O Module",
      "ipAddress": "192.168.1.20",
      "port": 502,
      "unitId": 1,
      "deviceType": "IO_Module"
    },
    {
      "id": "io_module_tank02",
      "name": "Tank 02 I/O Module",
      "ipAddress": "192.168.1.21",
      "port": 502,
      "unitId": 1,
      "deviceType": "IO_Module"
    }
  ],
  
  "registerMap": {
    "main_plc": {
      "system_status": [
        { "name": "System_Running", "address": 0, "fc": 2, "type": "BOOL" },
        { "name": "Emergency_Stop", "address": 1, "fc": 2, "type": "BOOL" },
        { "name": "Auto_Mode", "address": 2, "fc": 2, "type": "BOOL" }
      ],
      "tank_data": [
        { "name": "Tank01_Temp", "address": 40001, "fc": 3, "type": "FLOAT32" },
        { "name": "Tank01_pH", "address": 40003, "fc": 3, "type": "FLOAT32" },
        { "name": "Tank01_O2", "address": 40005, "fc": 3, "type": "FLOAT32" },
        { "name": "Tank02_Temp", "address": 40007, "fc": 3, "type": "FLOAT32" },
        { "name": "Tank02_pH", "address": 40009, "fc": 3, "type": "FLOAT32" },
        { "name": "Tank02_O2", "address": 40011, "fc": 3, "type": "FLOAT32" }
      ],
      "pump_control": [
        { "name": "Pump01_Speed", "address": 40100, "fc": 3, "type": "UINT16", "writable": true },
        { "name": "Pump02_Speed", "address": 40101, "fc": 3, "type": "UINT16", "writable": true },
        { "name": "Pump03_Speed", "address": 40102, "fc": 3, "type": "UINT16", "writable": true }
      ]
    }
  },
  
  "polling": {
    "groups": [
      {
        "name": "Critical_Parameters",
        "interval": 1000,
        "priority": "high",
        "registers": ["Tank01_Temp", "Tank01_O2", "Tank02_Temp", "Tank02_O2"]
      },
      {
        "name": "Secondary_Parameters",
        "interval": 2000,
        "priority": "normal",
        "registers": ["Tank01_pH", "Tank02_pH"]
      },
      {
        "name": "System_Status",
        "interval": 5000,
        "priority": "normal",
        "registers": ["System_Running", "Emergency_Stop", "Auto_Mode"]
      }
    ]
  },
  
  "alarms": {
    "levels": ["info", "warning", "alarm", "critical"],
    "rules": [
      {
        "name": "Critical_Temperature",
        "condition": "Tank01_Temp > 30 || Tank02_Temp > 30",
        "level": "critical",
        "actions": ["log", "email", "sms", "webhook"]
      },
      {
        "name": "Low_Oxygen",
        "condition": "Tank01_O2 < 6 || Tank02_O2 < 6",
        "level": "critical",
        "actions": ["log", "email", "webhook"]
      },
      {
        "name": "Emergency_Stop_Active",
        "condition": "Emergency_Stop == true",
        "level": "critical",
        "actions": ["log", "email", "sms"]
      }
    ]
  },
  
  "historian": {
    "enabled": true,
    "database": {
      "type": "influxdb",
      "host": "localhost",
      "port": 8086,
      "database": "oceanfarm_scada"
    },
    "aggregation": {
      "intervals": ["1m", "1h", "1d"],
      "operations": ["min", "max", "avg"]
    }
  },
  
  "redundancy": {
    "enabled": true,
    "primary": {
      "ipAddress": "192.168.1.10",
      "port": 502
    },
    "secondary": {
      "ipAddress": "192.168.2.10",
      "port": 502
    }
  },
  
  "security": {
    "accessControl": {
      "enabled": true,
      "writeRequiresAuth": true
    },
    "auditLog": {
      "enabled": true,
      "logWrites": true
    }
  }
}
```

---

## MİNİMUM ENDÜSTRİYEL YAPI

### Priority 1 (Kritik - Mutlaka Olmalı)
1. ✅ IP Address, Port, Unit ID
2. ✅ Function Code
3. ✅ Register Address, Count
4. ✅ Timeout
5. ❌ **Data Type Selection** (INT16, UINT16, FLOAT32, etc.)
6. ❌ **Byte Order** (Endianness - ABCD, DCBA, etc.)
7. ❌ **Polling Configuration**
8. ❌ **Multiple Slave Devices**
9. ❌ **Error Handling & Retry**
10. ❌ **Connection Management (Keep-Alive, Reconnect)**

### Priority 2 (Production için Gerekli)
11. ❌ **Register Mapping/Naming**
12. ❌ **Scaling & Unit Conversion**
13. ❌ **Bulk Read Optimization**
14. ❌ **Write Operations**
15. ❌ **Data Validation (Range Check)**
16. ❌ **Basic Alarms**
17. ❌ **Logging**
18. ❌ **Statistics**

### Priority 3 (SCADA/Enterprise için)
19. ❌ **Historical Data Storage**
20. ❌ **Advanced Alarms (Hysteresis, Deadband)**
21. ❌ **Triggered Writes (Rule-based)**
22. ❌ **Data Quality Flags**
23. ❌ **Redundancy/Failover**
24. ❌ **MQTT/OPC UA Bridge**
25. ❌ **Access Control & Audit Log**
26. ❌ **Register Groups**
27. ❌ **Health Check Monitoring**

---

## UI/UX TASARIM ÖNERİLERİ

### Tab Structure

#### Tab 1: Connection
- Device list (multiple slaves)
- IP Address, Port, Unit ID per device
- Connection type (Persistent/Per-Request)
- Keep-alive settings
- Auto-reconnect
- Test connection button

#### Tab 2: Registers
- Register mapping table
  - Name, Address, Function Code, Data Type, Byte Order
  - Count, Scaling, Unit
  - Range validation
  - Read/Write permissions
- Import/Export register map (CSV/JSON)
- Register groups

#### Tab 3: Polling
- Global polling interval
- Per-register/per-group intervals
- Priority-based polling
- Schedule configuration
- Bulk read settings

#### Tab 4: Write Operations
- Write permission toggle
- Manual write interface
- Scheduled writes (cron-based)
- Triggered writes (rule-based)
- Write verification

#### Tab 5: Alarms
- Alarm rules configuration
- Threshold settings
- Hysteresis/deadband
- Action configuration (log, email, webhook)
- Alarm history viewer

#### Tab 6: Data & Historian
- Historical storage settings
- Data aggregation
- Compression settings
- Database configuration
- Data export

#### Tab 7: Monitoring
- Real-time values display
- Statistics & metrics
- Connection status
- Error log
- Response time graph

#### Tab 8: Security
- Access control
- Audit log
- Network restrictions
- Write authentication

#### Tab 9: Advanced
- Redundancy settings
- MQTT/OPC bridge
- Custom scripts
- Diagnostic tools

---

## AQUACULTURE SİSTEMLERİ İÇİN ÖZEL ÖNERİLER

### 1. Kritik Parametreler (1s polling)
```javascript
criticalParams: [
  { name: "Temperature", address: 40001, alarm: "> 28" },
  { name: "Oxygen", address: 40003, alarm: "< 6" },
  { name: "pH", address: 40005, alarm: "< 7.0 || > 8.5" }
]
```

### 2. Pump/Equipment Control
```javascript
equipment: [
  {
    name: "Circulation_Pump",
    speedControl: { address: 40100, writable: true, unit: "RPM" },
    status: { address: 0, type: "coil" },
    interlock: "Temperature < 30"  // Safety interlock
  }
]
```

### 3. Multi-Tank System
```javascript
tanks: [
  {
    id: "tank_01",
    plc: "192.168.1.100",
    sensors: {
      temperature: 40001,
      ph: 40003,
      oxygen: 40005,
      salinity: 40007
    }
  },
  {
    id: "tank_02",
    plc: "192.168.1.101",
    sensors: { /* same mapping */ }
  }
]
```

### 4. Emergency Procedures
```javascript
emergencyActions: [
  {
    trigger: "Oxygen < 4",
    actions: [
      { type: "write", address: 00100, value: true },  // Start backup aerator
      { type: "write", address: 40150, value: 2000 },  // Max pump speed
      { type: "webhook", url: "/emergency-alert" }
    ]
  }
]
```

---

## YAYGN PLC/CIHAZ ÖZELLİKLERİ

### Siemens S7-1200/1500
- Byte Order: Big Endian (ABCD)
- Default Port: 502
- Unit ID: Genellikle 1
- Max Registers per Read: 125

### Allen-Bradley CompactLogix/ControlLogix
- Byte Order: Varies (usually CDAB)
- EtherNet/IP (not Modbus native)
- Modbus gateway gerekebilir

### Schneider Electric M340/M580
- Byte Order: Big Endian (ABCD)
- Default Port: 502
- Native Modbus TCP support

### Mitsubishi FX/Q Series
- Byte Order: Varies by model
- Default Port: 502
- Special register addressing

### VFD (Variable Frequency Drives)
- ABB, Danfoss, Siemens VFDs
- Genellikle: Speed (40001), Current (40010), Status (0-15 coils)
- Byte Order: Check manufacturer manual

---

## TEST VE VALİDASYON

### Connection Test
```javascript
testSequence: [
  { step: "TCP Connect", expected: "Success" },
  { step: "Read Holding Register 40001", expected: "Valid data" },
  { step: "Response Time", expected: "< 100ms" }
]
```

### Register Map Validation
```javascript
validation: [
  "Check address overlaps",
  "Verify data types match PLC configuration",
  "Test byte order with known values",
  "Validate scaling factors"
]
```

### Load Testing
```javascript
loadTest: {
  "simultaneousDevices": 10,
  "requestsPerSecond": 100,
  "duration": 3600,           // 1 hour
  "expectedResponseTime": "< 50ms",
  "expectedErrorRate": "< 1%"
}
```

---

## SONUÇ

Endüstriyel Modbus TCP sistemi için:

✅ **CORE Features:**
- Data types & byte order
- Multiple slave devices
- Bulk read optimization
- Polling & scheduling
- Error handling & retry
- Connection management

✅ **SCADA Features:**
- Register mapping & naming
- Scaling & conversion
- Alarms with hysteresis
- Historical data storage
- Write operations with verification
- Statistics & diagnostics

✅ **ENTERPRISE Features:**
- Redundancy & failover
- Access control & audit
- MQTT/OPC UA bridge
- Rule-based automation
- Advanced scheduling
- Data quality management

**kritik:**
1. Multi-device support (çoklu tank/PLC)
2. Alarm system (temperature, O2, pH thresholds)
3. Write operations (pump control, valve control)
4. Redundancy (system reliability)


İyi çalışmalar! 🏭🐟
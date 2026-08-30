/* @ts-self-types="./alarm_core_wasm.d.ts" */

/**
 * The canonical default `==`/`!=` epsilon (`1e-4`), re-exported for callers.
 * @returns {number}
 */
function defaultEpsilon() {
    const ret = wasm.defaultEpsilon();
    return ret;
}
exports.defaultEpsilon = defaultEpsilon;

/**
 * Return `true` when `elapsed_ms >= delay_ms` (millisecond precision, no
 * integer-second truncation). Values are integer milliseconds passed as `f64`
 * (exact for any realistic duration).
 *
 * The `f64 → u64` conversion is saturating and floors: `.max(0.0)` maps
 * negatives AND `NaN` to `0`, and `as u64` saturates at `u64::MAX` (no UB, no
 * panic). Under the integer-millisecond contract this is a no-op; a *fractional*
 * `delay_ms` would be floored (fire up to ~1 ms early), which callers avoid by
 * passing whole milliseconds.
 * @param {number} elapsed_ms
 * @param {number} delay_ms
 * @returns {boolean}
 */
function delayElapsed(elapsed_ms, delay_ms) {
    const ret = wasm.delayElapsed(elapsed_ms, delay_ms);
    return ret !== 0;
}
exports.delayElapsed = delayElapsed;

/**
 * Evaluate whether `value` satisfies `operator` against `threshold` (within
 * `epsilon` for `==`/`!=`). Unknown operator ⇒ `false`.
 * @param {string} operator
 * @param {number} value
 * @param {number} threshold
 * @param {number} epsilon
 * @returns {boolean}
 */
function evaluateCondition(operator, value, threshold, epsilon) {
    const ptr0 = passStringToWasm0(operator, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.evaluateCondition(ptr0, len0, value, threshold, epsilon);
    return ret !== 0;
}
exports.evaluateCondition = evaluateCondition;

/**
 * Return `true` when `value` is strictly past `threshold ± deadband` so an
 * active alarm may clear (exclusive hysteresis; `deadband == 0` ⇒ `true`).
 * @param {string} operator
 * @param {number} value
 * @param {number} threshold
 * @param {number} deadband
 * @returns {boolean}
 */
function isOutsideDeadband(operator, value, threshold, deadband) {
    const ptr0 = passStringToWasm0(operator, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.isOutsideDeadband(ptr0, len0, value, threshold, deadband);
    return ret !== 0;
}
exports.isOutsideDeadband = isOutsideDeadband;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./alarm_core_wasm_bg.js": import0,
    };
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/alarm_core_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();

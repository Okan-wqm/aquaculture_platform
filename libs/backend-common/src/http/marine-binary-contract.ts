/**
 * Maximum byte size accepted across every hop of the authenticated marine
 * imagery pipeline. Farm-service enforces it against CDSE and gateway-api
 * enforces the same value while streaming to the tenant browser.
 */
export const MARINE_BINARY_MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

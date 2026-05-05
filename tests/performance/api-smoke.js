import http from 'k6/http';
import { check } from 'k6';

export const options = {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750'],
  },
};

// 2026-04-30: Live API smoke benchmark for the manual Performance Benchmark
// workflow. It requires a real API_BASE_URL so CI cannot report a backend
// benchmark result when no backend target was actually exercised.
const baseUrl = __ENV.API_BASE_URL;

if (!baseUrl) {
  throw new Error('API_BASE_URL is required for tests/performance/api-smoke.js');
}

export default function apiSmoke() {
  const response = http.get(`${baseUrl.replace(/\/$/, '')}/health`);

  check(response, {
    'health endpoint returns 2xx': (res) => res.status >= 200 && res.status < 300,
  });
}

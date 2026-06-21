import http from 'node:http';
import https from 'node:https';

function resolveTransport(endpointUrl) {
  if (endpointUrl.protocol === 'http:') {
    return http;
  }
  if (endpointUrl.protocol === 'https:') {
    return https;
  }
  throw new Error(`Unsupported GraphQL endpoint protocol: ${endpointUrl.protocol}`);
}

function endpointPath(endpointUrl) {
  return `${endpointUrl.pathname || '/'}${endpointUrl.search}`;
}

export function createGraphqlRequester({ endpoint, tenantId, getToken }) {
  if (!endpoint) {
    throw new Error('GraphQL endpoint is required');
  }
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  const endpointUrl = new URL(endpoint);
  const transport = resolveTransport(endpointUrl);
  const port =
    endpointUrl.port === ''
      ? endpointUrl.protocol === 'https:'
        ? 443
        : 80
      : Number(endpointUrl.port);

  return function gqlRequest(query, variables = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ query, variables });
      const options = {
        hostname: endpointUrl.hostname,
        port,
        path: endpointPath(endpointUrl),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken() ?? ''}`,
          'x-tenant-id': tenantId,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors) {
              const firstError = parsed.errors[0]?.message ?? JSON.stringify(parsed.errors[0]);
              reject(new Error(firstError));
              return;
            }
            resolve(parsed.data);
          } catch {
            reject(new Error(`Failed to parse GraphQL response: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
}

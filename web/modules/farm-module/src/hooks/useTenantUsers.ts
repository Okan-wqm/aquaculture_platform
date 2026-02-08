import { useState, useEffect } from 'react';

export interface TenantUser {
  id: string;
  name: string;
  email: string;
}

const GRAPHQL_URL = '/graphql';

const TENANT_USERS_QUERY = `
  query TenantUsers {
    tenantUsers {
      id
      email
      firstName
      lastName
    }
  }
`;

const WORKERS_QUERY = `
  query Workers {
    workers {
      id
      firstName
      lastName
      email
    }
  }
`;

export function useTenantUsers() {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const token = localStorage.getItem('access_token');
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };

        // Fetch tenant users and workers in parallel
        const [usersResponse, workersResponse] = await Promise.all([
          fetch(GRAPHQL_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query: TENANT_USERS_QUERY }),
          }),
          fetch(GRAPHQL_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query: WORKERS_QUERY }),
          }).catch(() => null),
        ]);

        const usersResult = await usersResponse.json();
        if (usersResult.errors) {
          throw new Error(usersResult.errors[0]?.message || 'GraphQL error');
        }

        const apiUsers: Array<{
          id: string;
          email: string;
          firstName?: string;
          lastName?: string;
        }> = usersResult.data?.tenantUsers || [];

        const tenantUsers: TenantUser[] = apiUsers.map((u) => ({
          id: u.id,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
          email: u.email,
        }));

        // Merge workers (from employees table)
        const emailSet = new Set(tenantUsers.map((u) => u.email.toLowerCase()));

        if (workersResponse) {
          try {
            const workersResult = await workersResponse.json();
            const apiWorkers: Array<{
              id: string;
              firstName: string;
              lastName: string;
              email: string;
            }> = workersResult.data?.workers || [];

            for (const w of apiWorkers) {
              if (!emailSet.has(w.email.toLowerCase())) {
                tenantUsers.push({
                  id: w.id,
                  name: `${w.firstName} ${w.lastName}`.trim(),
                  email: w.email,
                });
                emailSet.add(w.email.toLowerCase());
              }
            }
          } catch {
            // Workers query may fail if farm-service doesn't have worker module yet
          }
        }

        setUsers(tenantUsers);
      } catch (err) {
        console.error('Failed to fetch tenant users:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, []);

  return { users, loading };
}

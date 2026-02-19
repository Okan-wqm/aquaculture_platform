import { useState, useEffect } from 'react';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

export interface TenantUser {
  id: string;
  name: string;
  email: string;
}

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
  const { token } = useAuth();
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    const fetchUsers = async () => {
      try {
        // Fetch tenant users and workers in parallel using graphqlClient
        const [usersResult, workersResult] = await Promise.allSettled([
          graphqlClient.request<{
            tenantUsers: Array<{
              id: string;
              email: string;
              firstName?: string;
              lastName?: string;
            }>;
          }>(TENANT_USERS_QUERY),
          graphqlClient.request<{
            workers: Array<{
              id: string;
              firstName: string;
              lastName: string;
              email: string;
            }>;
          }>(WORKERS_QUERY),
        ]);

        const apiUsers =
          usersResult.status === 'fulfilled'
            ? usersResult.value.tenantUsers || []
            : [];

        const tenantUsers: TenantUser[] = apiUsers.map((u) => ({
          id: u.id,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
          email: u.email,
        }));

        // Merge workers (from employees table), deduplicate by email
        const emailSet = new Set(tenantUsers.map((u) => u.email.toLowerCase()));

        if (workersResult.status === 'fulfilled') {
          const apiWorkers = workersResult.value.workers || [];
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
        }

        setUsers(tenantUsers);
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to fetch tenant users:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [token]);

  return { users, loading };
}

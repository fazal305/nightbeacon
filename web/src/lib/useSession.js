import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api.session();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return { authenticated: false };
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

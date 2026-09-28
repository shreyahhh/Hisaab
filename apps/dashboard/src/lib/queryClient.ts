import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

// dashboard.md §2.2: retry: 2 except on 4xx (a 4xx is a real answer, not a transient failure).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

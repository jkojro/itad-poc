"use client"
import { useQuery } from '@tanstack/react-query'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * Which of the given features the current user holds (platform feature check; the
 * server resolves wildcard grants). Only decides what UI to show — every route
 * enforces its own feature independently.
 */
export function useGrantedFeatures(features: readonly string[]): { granted: Set<string>; loading: boolean } {
  const { data, isLoading } = useQuery<string[]>({
    queryKey: ['itad-feature-check', ...features],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const call = await apiCall<{ granted?: unknown[] }>('/api/auth/feature-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ features }),
      })
      if (!call.ok) return []
      return Array.isArray(call.result?.granted) ? call.result.granted.map(String) : []
    },
  })
  return { granted: new Set(data ?? []), loading: isLoading }
}

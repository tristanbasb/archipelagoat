// IPC channels as TanStack queries and mutations. A query's key is [channel, input], so
// `invalidates: ['worlds:list']` refreshes every worlds:list query whatever its input.
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import type { GoatError } from '@shared/errors'
import type { ChannelInput, ChannelName, ChannelOutput } from '@shared/ipc/contract'
import { invoke } from '../lib/goat'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A local call that failed fails the same way again: show the error instead of retrying.
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
      mutations: { retry: false },
    },
  })
}

export type IpcQueryKey<C extends ChannelName> = readonly [C, ChannelInput<C>]

export type IpcQueryOptions<C extends ChannelName, TData = ChannelOutput<C>> = Omit<
  UseQueryOptions<ChannelOutput<C>, GoatError, TData, IpcQueryKey<C>>,
  'queryKey' | 'queryFn'
>

/** Queries a channel; errors are GoatError objects (read `code`, `params`, `detail`). */
export function useIpcQuery<C extends ChannelName, TData = ChannelOutput<C>>(
  channel: C,
  input: ChannelInput<C>,
  opts?: IpcQueryOptions<C, TData>,
): UseQueryResult<TData, GoatError> {
  return useQuery({
    ...opts,
    queryKey: [channel, input] as const,
    queryFn: () => invoke(channel, input),
  })
}

/** Channels that take no input can be mutated with `mutate()`. */
export type IpcMutationInput<C extends ChannelName> =
  undefined extends ChannelInput<C> ? ChannelInput<C> | void : ChannelInput<C>

export type IpcMutationOptions<C extends ChannelName> = Omit<
  UseMutationOptions<ChannelOutput<C>, GoatError, IpcMutationInput<C>>,
  'mutationFn'
> & {
  /** Channels whose queries are refreshed after a success. */
  invalidates?: readonly ChannelName[]
}

export function useIpcMutation<C extends ChannelName>(
  channel: C,
  { invalidates = [], onSuccess, ...opts }: IpcMutationOptions<C> = {},
): UseMutationResult<ChannelOutput<C>, GoatError, IpcMutationInput<C>> {
  const queryClient = useQueryClient()
  return useMutation({
    ...opts,
    mutationFn: (input) => invoke(channel, input as ChannelInput<C>),
    onSuccess: async (...args) => {
      await Promise.all(invalidates.map((name) => queryClient.invalidateQueries({ queryKey: [name] })))
      await onSuccess?.(...args)
    },
  })
}

import { useCallback, useState } from "react";

/**
 * Tracks an integer counter with increment/decrement/reset controls.
 *
 * @param initial - starting value for the counter
 * @returns the current count and stable control callbacks
 * @example
 * const { count, increment } = useCounter(0);
 */
export function useCounter(initial = 0) {
  const [count, setCount] = useState(initial);
  const increment = useCallback(() => setCount((c) => c + 1), []);
  const decrement = useCallback(() => setCount((c) => c - 1), []);
  const reset = useCallback(() => setCount(initial), [initial]);
  return { count, increment, decrement, reset };
}

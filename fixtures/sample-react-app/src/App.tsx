import { Button } from "./components/Button.js";
import { useCounter } from "./hooks/useCounter.js";
import { formatDuration } from "./utils/format.js";

/**
 * Root application component. Wires the counter hook to the button UI and
 * shows the count formatted as a duration.
 */
export function App() {
  const { count, increment, decrement, reset } = useCounter(0);
  return (
    <main>
      <h1>Sample App</h1>
      <p>Elapsed: {formatDuration(count)}</p>
      <Button onClick={increment}>+</Button>
      <Button variant="secondary" onClick={decrement}>
        −
      </Button>
      <Button variant="secondary" disabled={count === 0} onClick={reset}>
        reset
      </Button>
    </main>
  );
}

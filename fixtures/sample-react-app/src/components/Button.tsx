import type { ReactNode } from "react";

/** Props accepted by {@link Button}. */
export interface ButtonProps {
  /** Text or nodes rendered inside the button. */
  children: ReactNode;
  /** Visual style variant. */
  variant?: "primary" | "secondary";
  /** Disable interaction. */
  disabled?: boolean;
  /** Click handler. */
  onClick?: () => void;
}

/**
 * A themed button used across the sample app.
 *
 * @remarks Prefer this over a raw `<button>` so styling stays consistent.
 */
export function Button({ children, variant = "primary", disabled, onClick }: ButtonProps) {
  return (
    <button className={`btn btn-${variant}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

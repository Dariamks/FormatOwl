'use client';
import { useEffect, useRef, type ReactNode } from 'react';
export function WorkspaceDialog({
  open,
  onClose,
  label,
  children,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    else if (!open && ref.current?.open) ref.current?.close();
  }, [open]);
  return (
    <dialog
      className={`workspace-dialog ${className}`}
      ref={ref}
      aria-label={label}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

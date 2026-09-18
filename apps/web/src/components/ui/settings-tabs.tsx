'use client';

import { useId, useRef, useState, type ReactNode } from 'react';

/** Switch settings views without discarding controls or their values. */
export function SettingsTabs({
  label,
  basicLabel,
  advancedLabel,
  basic,
  advanced,
  common,
  disabled = false,
}: {
  label: string;
  basicLabel: string;
  advancedLabel: string;
  basic: ReactNode;
  advanced: ReactNode;
  common?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = [basicLabel, advancedLabel];

  return (
    <div className="settings-tabs">
      <div
        className="settings-tablist"
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
      >
        {labels.map((title, index) => (
          <button
            key={index}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel-${index}`}
            aria-selected={active === index}
            tabIndex={active === index ? 0 : -1}
            disabled={disabled}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = 1 - index;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = 1;
              else return;
              event.preventDefault();
              setActive(next);
              buttons.current[next]?.focus();
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {common && <div className="settings-common">{common}</div>}
      {[basic, advanced].map((content, index) => (
        <div
          key={index}
          className="settings-tabpanel"
          id={`${id}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${index}`}
          hidden={active !== index}
          tabIndex={0}
        >
          {content}
        </div>
      ))}
    </div>
  );
}

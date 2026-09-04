import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import './Tabs.css';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number | undefined;
}

export interface TabsProps {
  readonly items: ReadonlyArray<TabItem>;
  readonly active: string;
  readonly onChange: (id: string) => void;
  readonly label: string;
}

/**
 * WAI-ARIA tablist with roving focus: Left/Right/Home/End move between tabs and
 * activate them, so the panel below is reachable without a pointer.
 */
export function Tabs({ items, active, onChange, label }: TabsProps): ReactNode {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const focusAndActivate = (index: number): void => {
    const item = items[index];
    if (item === undefined) {
      return;
    }
    buttons.current[index]?.focus();
    onChange(item.id);
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = items.length - 1;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusAndActivate(index === last ? 0 : index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusAndActivate(index === 0 ? last : index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAndActivate(0);
        break;
      case 'End':
        event.preventDefault();
        focusAndActivate(last);
        break;
      default:
        break;
    }
  };

  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={`tabs__tab${selected ? ' tabs__tab--active' : ''}`}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => handleKey(event, index)}
          >
            {item.label}
            {item.count !== undefined ? <span className="tabs__count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  readonly id: string;
  readonly children: ReactNode;
}

export function TabPanel({ id, children }: TabPanelProps): ReactNode {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="tabs__panel">
      {children}
    </div>
  );
}

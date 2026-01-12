import React, { ChangeEvent } from 'react';

type Option = {
  value: string;
  label: string;
};

interface FormFieldProps {
  nodeId: string;
  fieldKey: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select';
  value?: string | number;
  checked?: boolean;
  options?: Option[];
  onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
}

export default function FormField({
  nodeId,
  fieldKey,
  label,
  type,
  value,
  checked,
  options = [],
  onChange,
}: FormFieldProps) {
  // build a unique id/name for every field
  const id = `${nodeId}-${fieldKey}`;
  const name = id;

  return (
    <div className="form-field" style={{ marginBottom: 8 }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </label>

      {type === 'select' ? (
        <select
          id={id}
          name={name}
          value={value as string}
          onChange={onChange}
          style={{ width: '100%' }}
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          value={type === 'checkbox' ? undefined : (value as string | number | undefined)}
          checked={type === 'checkbox' ? checked : undefined}
          onChange={onChange}
          style={{ width: '100%' }}
        />
      )}
    </div>
  );
}

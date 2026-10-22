import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DepartmentBadge } from '../DepartmentBadge';

const operations = { name: 'Operations', code: 'OPS', moduleCode: 'FARM' as const };

describe('DepartmentBadge', () => {
  it('shows the department an employee is placed in', () => {
    render(<DepartmentBadge department={operations} />);

    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.queryByText(/Production/)).not.toBeInTheDocument();
  });

  it('names the module of the department on request', () => {
    render(<DepartmentBadge department={operations} showModule />);

    expect(screen.getByText('· Production')).toBeInTheDocument();
  });

  it('names a department with no module as company-wide', () => {
    render(
      <DepartmentBadge
        department={{ name: 'Finance', code: 'FIN', moduleCode: null }}
        showModule
      />,
    );

    expect(screen.getByText('· Company-wide')).toBeInTheDocument();
  });

  it('prints the code before the name when asked', () => {
    render(<DepartmentBadge department={operations} showCode />);

    expect(screen.getByText('OPS')).toBeInTheDocument();
  });
});

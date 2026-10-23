import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildEmployee } from '../../../test-utils/employee';
import { EmployeeCard } from '../EmployeeCard';

const employee = buildEmployee();

describe('EmployeeCard', () => {
  it('shows the department the employee is placed in, with its module', () => {
    render(<EmployeeCard employee={employee} />);

    expect(screen.getByText('Deck')).toBeInTheDocument();
    expect(screen.getByText('· Production')).toBeInTheDocument();
  });

  it('shows no department for an employee who is placed in none', () => {
    render(
      <EmployeeCard employee={{ ...employee, departmentHrId: undefined, departmentHr: null }} />,
    );

    expect(screen.queryByText('Deck')).not.toBeInTheDocument();
  });
});

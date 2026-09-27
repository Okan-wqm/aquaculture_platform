/**
 * Certification dialogs (FE-MEDIUM-092) — the actions the dashboard's
 * controls promised and never had: add a certification to an employee, define
 * a certification type, renew a certification. Each is a Modal over the
 * existing mutation hooks; a required field that is missing reports on the
 * field, and the mutation's own toast reports the outcome.
 */

import React, { useState } from 'react';
import { Button, FormField, Input, Modal, Select, Textarea } from '@aquaculture/shared-ui';

import {
  useAddEmployeeCertification,
  useCreateCertificationType,
  useRenewCertification,
} from '../../hooks';
import { CertificationCategory, CertificationRequirement } from '../../types';
import type { CertificationType, Employee, EmployeeCertification } from '../../types';

const today = (): string => new Date().toISOString().slice(0, 10);
const employeeLabel = (employee: Employee): string =>
  `${employee.firstName} ${employee.lastName} (${employee.employeeNumber})`;
const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

// ============================================================================
// Add certification
// ============================================================================

export interface AddCertificationModalProps {
  open: boolean;
  onClose: () => void;
  employees: readonly Employee[];
  certificationTypes: readonly CertificationType[];
}

const EMPTY_CERTIFICATION = {
  employeeId: '',
  certificationTypeId: '',
  issueDate: '',
  expiryDate: '',
  issuingAuthority: '',
};

export const AddCertificationModal: React.FC<AddCertificationModalProps> = ({
  open,
  onClose,
  employees,
  certificationTypes,
}) => {
  const add = useAddEmployeeCertification();
  const [form, setForm] = useState({ ...EMPTY_CERTIFICATION, issueDate: today() });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = (): void => {
    setForm({ ...EMPTY_CERTIFICATION, issueDate: today() });
    setErrors({});
    onClose();
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.employeeId) next.employeeId = 'Choose an employee';
    if (!form.certificationTypeId) next.certificationTypeId = 'Choose a certification type';
    if (!form.issueDate) next.issueDate = 'Enter the issue date';
    if (form.expiryDate && form.issueDate && form.expiryDate < form.issueDate)
      next.expiryDate = 'The expiry date is before the issue date';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    add.mutate(
      {
        employeeId: form.employeeId,
        certificationTypeId: form.certificationTypeId,
        issueDate: form.issueDate,
        expiryDate: form.expiryDate || undefined,
        issuingAuthority: form.issuingAuthority.trim() || undefined,
      },
      { onSuccess: close },
    );
  };

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="Add Certification"
      size="md"
      bodyClassName="p-6"
      closeOnEscape={!add.isPending}
      closeOnOverlayClick={!add.isPending}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close} disabled={add.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="add-certification-form"
            loading={add.isPending}
          >
            Add Certification
          </Button>
        </>
      }
    >
      <form id="add-certification-form" onSubmit={handleSubmit} className="space-y-4">
        <FormField
          label="Employee"
          htmlFor="add-cert-employee"
          required
          error={form.employeeId ? undefined : errors.employeeId}
          className="mb-0"
        >
          <Select
            id="add-cert-employee"
            value={form.employeeId}
            onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
            options={[
              { value: '', label: 'Select an employee' },
              ...employees.map((employee) => ({
                value: employee.id,
                label: employeeLabel(employee),
              })),
            ]}
          />
        </FormField>
        <FormField
          label="Certification type"
          htmlFor="add-cert-type"
          required
          error={form.certificationTypeId ? undefined : errors.certificationTypeId}
          className="mb-0"
        >
          <Select
            id="add-cert-type"
            value={form.certificationTypeId}
            onChange={(e) => setForm({ ...form, certificationTypeId: e.target.value })}
            options={[
              { value: '', label: 'Select a type' },
              ...certificationTypes.map((type) => ({
                value: type.id,
                label: `${type.name} (${type.code})`,
              })),
            ]}
          />
        </FormField>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            label="Issue date"
            htmlFor="add-cert-issue"
            required
            error={form.issueDate ? undefined : errors.issueDate}
            className="mb-0"
          >
            <Input
              id="add-cert-issue"
              type="date"
              value={form.issueDate}
              onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
            />
          </FormField>
          <FormField
            label="Expiry date"
            htmlFor="add-cert-expiry"
            error={errors.expiryDate}
            className="mb-0"
          >
            <Input
              id="add-cert-expiry"
              type="date"
              value={form.expiryDate}
              onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
            />
          </FormField>
        </div>
        <FormField label="Issuing authority" htmlFor="add-cert-authority" className="mb-0">
          <Input
            id="add-cert-authority"
            value={form.issuingAuthority}
            onChange={(e) => setForm({ ...form, issuingAuthority: e.target.value })}
            placeholder="e.g. Maritime Authority"
          />
        </FormField>
      </form>
    </Modal>
  );
};

// ============================================================================
// Add certification type
// ============================================================================

export interface AddCertificationTypeModalProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY_TYPE = {
  code: '',
  name: '',
  description: '',
  category: CertificationCategory.SAFETY,
  requirement: CertificationRequirement.RECOMMENDED,
  issuingAuthority: '',
  validityMonths: '',
};

export const AddCertificationTypeModal: React.FC<AddCertificationTypeModalProps> = ({
  open,
  onClose,
}) => {
  const create = useCreateCertificationType();
  const [form, setForm] = useState(EMPTY_TYPE);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = (): void => {
    setForm(EMPTY_TYPE);
    setErrors({});
    onClose();
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.code.trim()) next.code = 'Enter a code';
    if (!form.name.trim()) next.name = 'Enter a name';
    const validityMonths =
      form.validityMonths.trim() === '' ? undefined : Number(form.validityMonths);
    if (validityMonths !== undefined && (!Number.isInteger(validityMonths) || validityMonths <= 0))
      next.validityMonths = 'Enter a whole number of months';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    create.mutate(
      {
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        category: form.category,
        requirement: form.requirement,
        issuingAuthority: form.issuingAuthority.trim() || undefined,
        validityMonths,
        requiresRenewal: validityMonths !== undefined,
      },
      { onSuccess: close },
    );
  };

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="Add Certification Type"
      size="md"
      bodyClassName="p-6"
      closeOnEscape={!create.isPending}
      closeOnOverlayClick={!create.isPending}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="add-certification-type-form"
            loading={create.isPending}
          >
            Create Type
          </Button>
        </>
      }
    >
      <form id="add-certification-type-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            label="Code"
            htmlFor="cert-type-code"
            required
            error={form.code.trim() ? undefined : errors.code}
            className="mb-0"
          >
            <Input
              id="cert-type-code"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. STCW-BST"
              className="uppercase"
            />
          </FormField>
          <FormField
            label="Name"
            htmlFor="cert-type-name"
            required
            error={form.name.trim() ? undefined : errors.name}
            className="mb-0"
          >
            <Input
              id="cert-type-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Basic Safety Training"
            />
          </FormField>
        </div>
        <FormField label="Description" htmlFor="cert-type-description" className="mb-0">
          <Textarea
            id="cert-type-description"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </FormField>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Category" htmlFor="cert-type-category" className="mb-0">
            <Select
              id="cert-type-category"
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value as CertificationCategory })
              }
              options={Object.values(CertificationCategory).map((category) => ({
                value: category,
                label: titleCase(category),
              }))}
            />
          </FormField>
          <FormField label="Requirement" htmlFor="cert-type-requirement" className="mb-0">
            <Select
              id="cert-type-requirement"
              value={form.requirement}
              onChange={(e) =>
                setForm({ ...form, requirement: e.target.value as CertificationRequirement })
              }
              options={Object.values(CertificationRequirement).map((requirement) => ({
                value: requirement,
                label: titleCase(requirement),
              }))}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Issuing authority" htmlFor="cert-type-authority" className="mb-0">
            <Input
              id="cert-type-authority"
              value={form.issuingAuthority}
              onChange={(e) => setForm({ ...form, issuingAuthority: e.target.value })}
            />
          </FormField>
          <FormField
            label="Validity (months)"
            htmlFor="cert-type-validity"
            error={errors.validityMonths}
            className="mb-0"
          >
            <Input
              id="cert-type-validity"
              type="number"
              min={1}
              value={form.validityMonths}
              onChange={(e) => setForm({ ...form, validityMonths: e.target.value })}
              placeholder="Leave empty if it does not expire"
            />
          </FormField>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Renew certification
// ============================================================================

export interface RenewCertificationModalProps {
  certification: EmployeeCertification | null;
  onClose: () => void;
}

export const RenewCertificationModal: React.FC<RenewCertificationModalProps> = ({
  certification,
  onClose,
}) => {
  const renew = useRenewCertification();
  const [newExpiryDate, setNewExpiryDate] = useState('');
  const [certificateNumber, setCertificateNumber] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const close = (): void => {
    setNewExpiryDate('');
    setCertificateNumber('');
    setError(undefined);
    onClose();
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!certification) return;
    if (!newExpiryDate) {
      setError('Enter the new expiry date');
      return;
    }
    if (newExpiryDate <= today()) {
      setError('The new expiry date must be in the future');
      return;
    }
    setError(undefined);
    renew.mutate(
      {
        certificationId: certification.id,
        newExpiryDate,
        certificateNumber: certificateNumber.trim() || undefined,
      },
      { onSuccess: close },
    );
  };

  const typeName =
    certification?.certificationType?.name ?? certification?.certificationTypeId ?? '';
  const holder = certification?.employee
    ? employeeLabel(certification.employee)
    : (certification?.employeeId ?? '');

  return (
    <Modal
      isOpen={certification !== null}
      onClose={close}
      title="Renew Certification"
      description={certification ? `${typeName} — ${holder}` : undefined}
      size="sm"
      bodyClassName="p-6"
      closeOnEscape={!renew.isPending}
      closeOnOverlayClick={!renew.isPending}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close} disabled={renew.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="renew-certification-form"
            loading={renew.isPending}
          >
            Renew
          </Button>
        </>
      }
    >
      <form id="renew-certification-form" onSubmit={handleSubmit} className="space-y-4">
        <FormField
          label="New expiry date"
          htmlFor="renew-expiry"
          required
          error={error}
          className="mb-0"
        >
          <Input
            id="renew-expiry"
            type="date"
            value={newExpiryDate}
            onChange={(e) => setNewExpiryDate(e.target.value)}
            min={today()}
          />
        </FormField>
        <FormField label="New certificate number" htmlFor="renew-number" className="mb-0">
          <Input
            id="renew-number"
            value={certificateNumber}
            onChange={(e) => setCertificateNumber(e.target.value)}
            placeholder={certification?.certificationNumber ?? ''}
          />
        </FormField>
      </form>
    </Modal>
  );
};

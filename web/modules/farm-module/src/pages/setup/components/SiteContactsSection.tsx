/**
 * SiteContactsSection — frontend surface for upsertSiteContacts (Scope A 4.4.3).
 *
 * Standalone editable list of {name, role, email, phone, isPrimary}
 * rows. Embedded inside `SiteFormModal` when editing an existing
 * site (the section is hidden in CREATE mode because the upsert
 * mutation requires a `siteId` that doesn't exist yet — operator
 * saves the site first, reopens it, then edits contacts).
 *
 * Architectural rationale — why a SEPARATE submit (not folded into
 * the site form's main "Save"):
 *   - The site form already calls `useCreateSite` / `useUpdateSite`
 *     mutations on submit. Folding contacts into the same submit
 *     would mean: (a) backend createSite gains a `contacts[]` input
 *     argument (not in scope for this PR — see Phase 4.4.3 plan
 *     follow-up note), or (b) frontend issues TWO mutations
 *     sequentially, with manual rollback if the second fails. Both
 *     are larger architectural moves than this PR carries.
 *   - Contacts are independent of site metadata — they can be
 *     edited without modifying the site, and vice versa. Two save
 *     buttons match the two-concern shape.
 *   - The user-visible UX is acceptable: contacts go live as soon
 *     as the operator saves the section, distinct from the main
 *     site fields. A small "Saved" toast on each side keeps
 *     feedback proportional.
 *
 * Validation:
 *   - At most one row may have `isPrimary=true` (UI gate; backend
 *     handler also pre-checks; DB partial unique index is the
 *     authoritative gate).
 *   - Each row's `name` is required (>= 1 char trimmed).
 *   - Email validated by `<input type="email">` browser pattern (same
 *     posture as elsewhere in this app); backend also runs RFC-5321
 *     validation via class-validator's `@IsEmail()`.
 *   - Empty list is valid (semantics: "clear all contacts").
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import {
  type SiteContact,
  type SiteContactInput,
  useSiteContacts,
  useUpsertSiteContacts,
} from '../../../hooks/useSites';

interface SiteContactsSectionProps {
  /**
   * The site whose contacts are being edited. When undefined the
   * section renders a small explanatory placeholder — needed because
   * the SiteFormModal can be opened in CREATE mode where no siteId
   * exists yet.
   */
  siteId: string | undefined;
}

interface RowDraft {
  /**
   * Local-only id for React key stability across reorders. Server
   * never sees this — the backend assigns its own ids on save.
   */
  localKey: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

function rowFromServer(c: SiteContact): RowDraft {
  return {
    localKey: c.id,
    name: c.name,
    role: c.role ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    isPrimary: c.isPrimary,
  };
}

function blankRow(): RowDraft {
  return {
    localKey: crypto.randomUUID(),
    name: '',
    role: '',
    email: '',
    phone: '',
    isPrimary: false,
  };
}

const SiteContactsSection: React.FC<SiteContactsSectionProps> = ({ siteId }) => {
  const { toast } = useToast();
  const canEdit = useCanMutate('upsertSiteContacts');
  const contactsQuery = useSiteContacts(siteId);
  const upsertMutation = useUpsertSiteContacts();

  const [rows, setRows] = useState<RowDraft[]>([]);

  // Sync local draft from server data whenever the modal re-opens
  // against a different site OR the server data refetches. Operators
  // discarding edits is a conscious move (close + reopen) — we
  // treat the server as source-of-truth on (re-)load.
  useEffect(() => {
    if (contactsQuery.data) {
      setRows(contactsQuery.data.map(rowFromServer));
    }
  }, [contactsQuery.data, siteId]);

  const errors: string[] = useMemo(() => {
    const errs: string[] = [];
    const primaryCount = rows.filter((r) => r.isPrimary).length;
    if (primaryCount > 1) {
      errs.push(
        `En fazla bir kişi ana irtibat olarak işaretlenebilir; ${primaryCount} kişi seçili.`,
      );
    }
    rows.forEach((r, idx) => {
      if (!r.name.trim()) {
        errs.push(`${idx + 1}. satırda isim boş olamaz.`);
      }
    });
    return errs;
  }, [rows]);

  if (!siteId) {
    return (
      <div className="mt-6 p-4 bg-gray-50 border border-dashed border-gray-300 rounded-lg">
        <h3 className="text-sm font-semibold text-gray-700">İrtibat Kişileri</h3>
        <p className="mt-1 text-xs text-gray-500">
          Site oluşturulduktan sonra irtibat kişileri eklenebilir.
          Önce yukarıdaki "Kaydet" butonu ile siteyi oluşturun.
        </p>
      </div>
    );
  }

  if (!canEdit) {
    // Read-only render for users who can see contacts but not edit.
    return (
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-700">İrtibat Kişileri</h3>
        {contactsQuery.isLoading ? (
          <p className="mt-1 text-xs text-gray-500">Yükleniyor…</p>
        ) : (contactsQuery.data ?? []).length === 0 ? (
          <p className="mt-1 text-xs text-gray-500">Tanımlı irtibat yok.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {(contactsQuery.data ?? []).map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.name}</span>
                {c.role && <span className="text-gray-500"> · {c.role}</span>}
                {c.email && <span className="text-gray-500"> · {c.email}</span>}
                {c.phone && <span className="text-gray-500"> · {c.phone}</span>}
                {c.isPrimary && (
                  <span className="ml-2 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
                    Ana
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const handleAddRow = () => {
    setRows((prev) => [...prev, blankRow()]);
  };

  const handleRemoveRow = (localKey: string) => {
    setRows((prev) => prev.filter((r) => r.localKey !== localKey));
  };

  const handleChange = (
    localKey: string,
    patch: Partial<Omit<RowDraft, 'localKey'>>,
  ) => {
    setRows((prev) =>
      prev.map((r) => (r.localKey === localKey ? { ...r, ...patch } : r)),
    );
  };

  const handleMarkPrimary = (localKey: string) => {
    // Marking a row primary unmarks every other row — UI mirror of
    // the partial unique constraint at the DB level.
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        isPrimary: r.localKey === localKey,
      })),
    );
  };

  const handleSubmit = async () => {
    if (errors.length > 0 || upsertMutation.isPending) return;
    const contacts: SiteContactInput[] = rows.map((r) => ({
      name: r.name.trim(),
      role: r.role.trim() || undefined,
      email: r.email.trim() || undefined,
      phone: r.phone.trim() || undefined,
      isPrimary: r.isPrimary,
    }));
    try {
      await upsertMutation.mutateAsync({ siteId, contacts });
      toast({
        title: 'İrtibat kişileri güncellendi',
        description: `${contacts.length} kişi kaydedildi.`,
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'İrtibat kaydı başarısız',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">İrtibat Kişileri</h3>
        <button
          type="button"
          onClick={handleAddRow}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          + Yeni Kişi
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Sitenin operatif irtibat kişileri. En fazla bir kişi "ana
        irtibat" olarak işaretlenebilir.
      </p>

      {contactsQuery.isLoading ? (
        <p className="mt-3 text-sm text-gray-500">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <div className="mt-3 p-3 bg-gray-50 border border-dashed border-gray-300 rounded text-sm text-gray-500 text-center">
          Tanımlı irtibat yok. "Yeni Kişi" ile satır ekleyin.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <div
              key={row.localKey}
              className="grid grid-cols-1 md:grid-cols-12 gap-2 p-2 border border-gray-200 rounded"
            >
              <input
                type="text"
                placeholder="İsim *"
                value={row.name}
                onChange={(e) =>
                  handleChange(row.localKey, { name: e.target.value })
                }
                className="md:col-span-3 px-2 py-1 text-sm border border-gray-300 rounded"
                maxLength={100}
              />
              <input
                type="text"
                placeholder="Rol"
                value={row.role}
                onChange={(e) =>
                  handleChange(row.localKey, { role: e.target.value })
                }
                className="md:col-span-2 px-2 py-1 text-sm border border-gray-300 rounded"
                maxLength={100}
              />
              <input
                type="email"
                placeholder="E-posta"
                value={row.email}
                onChange={(e) =>
                  handleChange(row.localKey, { email: e.target.value })
                }
                className="md:col-span-3 px-2 py-1 text-sm border border-gray-300 rounded"
                maxLength={150}
              />
              <input
                type="tel"
                placeholder="Telefon"
                value={row.phone}
                onChange={(e) =>
                  handleChange(row.localKey, { phone: e.target.value })
                }
                className="md:col-span-2 px-2 py-1 text-sm border border-gray-300 rounded"
                maxLength={50}
              />
              <div className="md:col-span-2 flex items-center justify-end gap-2">
                <label className="flex items-center gap-1 text-xs text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="primaryContact"
                    checked={row.isPrimary}
                    onChange={() => handleMarkPrimary(row.localKey)}
                    className="h-3 w-3"
                  />
                  Ana
                </label>
                <button
                  type="button"
                  onClick={() => handleRemoveRow(row.localKey)}
                  className="text-xs text-red-600 hover:text-red-800"
                  aria-label={`${row.name || 'Kişi'} satırını çıkar`}
                >
                  Sil
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <ul className="mt-3 bg-red-50 border border-red-200 rounded-md p-2 text-xs text-red-800 space-y-1">
          {errors.map((msg, idx) => (
            <li key={idx}>• {msg}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={errors.length > 0 || upsertMutation.isPending}
          isLoading={upsertMutation.isPending}
        >
          İrtibatları Kaydet
        </Button>
      </div>
    </div>
  );
};

export default SiteContactsSection;

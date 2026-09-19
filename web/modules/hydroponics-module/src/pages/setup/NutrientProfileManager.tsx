import React, { useState, useMemo } from 'react';
import { Select, NumberInput, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import { Modal } from '@aquaculture/shared-ui';
// PERF-HYD-002: Consume the shared profiles context rather than instantiating a
// separate useNutrientProfiles() hook, which would create a duplicate localStorage
// instance and an independent state copy that diverges from useLookupValues.
import { useNutrientProfilesContext } from '../../context/NutrientProfilesContext';
import type { NutrientProfile } from '../../types/modes.types';
import {
  SPECIES_OPTIONS,
  SPECIES_STAGES,
  STAGE_OPTIONS,
  SEASON_OPTIONS,
} from '../../types/solution.types';

// BUG-HYD-018: Derive the stage filter options from the union of all SPECIES_STAGES
// values rather than the legacy STAGE_OPTIONS (which includes 'fruiting3' that appears
// in no per-species list, creating a dead filter option).
const STAGE_FILTER_OPTIONS: { value: string | number; label: string }[] = (() => {
  const seen = new Set<string | number>();
  const options: { value: string | number; label: string }[] = [];
  for (const stages of Object.values(SPECIES_STAGES)) {
    for (const s of stages) {
      if (!seen.has(s.value)) {
        seen.add(s.value);
        options.push(s);
      }
    }
  }
  return options;
})();

const EMPTY_PROFILE: Omit<NutrientProfile, 'id'> = {
  species: 'tomato',
  cultivationStage: 'vegetative',
  season: 'spring_fall',
  ec: 2.0,
  ph: 5.5,
  kRatio: 0.44,
  caRatio: 0.36,
  mgRatio: 0.20,
  nkRatio: 1.30,
  nh4Ratio: 0.04,
  p: 1.25,
  cl: 0.5,
  si: 0.5,
  minSO4: 0.75,
  fe: 25,
  mn: 10,
  zn: 5,
  cu: 0.75,
  b: 30,
  mo: 0.5,
};

type ProfileFormData = Omit<NutrientProfile, 'id'>;

const NutrientProfileManager: React.FC = () => {
  const { profiles, saveProfile, deleteProfile, importDefaults } = useNutrientProfilesContext();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormData>({ ...EMPTY_PROFILE });
  const [filterSpecies, setFilterSpecies] = useState('');
  const [filterStage, setFilterStage] = useState('');

  const filteredProfiles = useMemo(() => {
    // PERF-HYD-008: Short-circuit when no filters are active.
    if (!filterSpecies && !filterStage) return profiles;
    return profiles.filter((p) => {
      if (filterSpecies && p.species !== filterSpecies) return false;
      if (filterStage && p.cultivationStage !== filterStage) return false;
      return true;
    });
  }, [profiles, filterSpecies, filterStage]);

  const openAdd = () => {
    setEditingId(null);
    setForm({ ...EMPTY_PROFILE });
    setIsModalOpen(true);
  };

  const openEdit = (profile: NutrientProfile) => {
    setEditingId(profile.id);
    const { id, ...rest } = profile;
    setForm(rest);
    setIsModalOpen(true);
  };

  const handleSave = () => {
    // SEC-HYD-005: Use crypto.randomUUID() instead of Date.now() to avoid ID collisions
    // in rapid save sequences (same millisecond) and predictable sequential IDs.
    const id = editingId || crypto.randomUUID();
    saveProfile({ ...form, id });
    setIsModalOpen(false);
    setEditingId(null);
    setForm({ ...EMPTY_PROFILE });
  };

  const updateForm = (key: keyof ProfileFormData, value: string | number) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const getLabel = (options: { value: string | number; label: string }[], value: string) =>
    options.find((o) => String(o.value) === value)?.label ?? value;

  type PRow = (typeof filteredProfiles)[number];
  const pRowColumns: DataTableColumn<PRow>[] = [
    {
      key: 'species',
      header: 'Species',
      render: (_value, p) => getLabel(SPECIES_OPTIONS, p.species),
    },
    {
      key: 'stage',
      header: 'Stage',
      render: (_value, p) => getLabel(STAGE_OPTIONS, p.cultivationStage),
    },
    {
      key: 'season',
      header: 'Season',
      render: (_value, p) => getLabel(SEASON_OPTIONS, p.season),
    },
    {
      key: 'ec',
      header: 'EC',
      render: (_value, p) => p.ec,
    },
    {
      key: 'ph',
      header: 'pH',
      render: (_value, p) => p.ph,
    },
    {
      key: 'kRatio',
      header: 'K Ratio',
      render: (_value, p) => p.kRatio,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, p) => (
        <>
          <button
            onClick={() => openEdit(p)}
            className="text-blue-600 hover:text-blue-800 text-xs font-medium mr-3"
          >
            Edit
          </button>
          <button
            onClick={() => deleteProfile(p.id)}
            className="text-red-600 hover:text-red-800 text-xs font-medium"
          >
            Delete
          </button>
        </>
      ),
    }
  ];

  return (
    <div className="space-y-4">
      {/* Actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Profile
        </button>
        <button
          onClick={() => void importDefaults()}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Import Default Data
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">{profiles.length} profile(s) total</span>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="w-48">
          <Select
            label="Filter by Species"
            options={[{ value: '', label: 'All Species' }, ...SPECIES_OPTIONS]}
            value={filterSpecies}
            onChange={(e) => setFilterSpecies(e.target.value)}
            size="sm"
          />
        </div>
        <div className="w-48">
          {/* BUG-HYD-018: Use STAGE_FILTER_OPTIONS derived from SPECIES_STAGES union,
              not STAGE_OPTIONS which contains 'fruiting3' — a stage that exists in no profile. */}
          <Select
            label="Filter by Stage"
            options={[{ value: '', label: 'All Stages' }, ...STAGE_FILTER_OPTIONS]}
            value={filterStage}
            onChange={(e) => setFilterStage(e.target.value)}
            size="sm"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <DataTable<PRow>
          data={filteredProfiles}
          columns={pRowColumns}
          keyExtractor={(p) => p.id}
          emptyMessage={'No profiles found. Click "Add Profile" or "Import Default Data" to get started.'}
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      </div>

      {/* Add/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          // BUG-HYD-012: Reset form state on close so a subsequent "Add Profile" does not
          // inherit stale editing data from a previously cancelled edit.
          setIsModalOpen(false);
          setEditingId(null);
          setForm({ ...EMPTY_PROFILE });
        }}
        title={editingId ? 'Edit Profile' : 'Add Profile'}
        size="lg"
      >
        <div className="space-y-4 p-4">
          {/* Identity */}
          <div className="grid grid-cols-3 gap-4">
            <Select
              label="Species"
              options={SPECIES_OPTIONS}
              value={form.species}
              onChange={(e) => updateForm('species', e.target.value)}
            />
            <Select
              label="Cultivation Stage"
              options={STAGE_OPTIONS}
              value={form.cultivationStage}
              onChange={(e) => updateForm('cultivationStage', e.target.value)}
            />
            <Select
              label="Season"
              options={SEASON_OPTIONS}
              value={form.season}
              onChange={(e) => updateForm('season', e.target.value)}
            />
          </div>

          {/* Main Parameters */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-3">Main Parameters</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <NumberInput label="EC (mS/cm)" value={form.ec} onChange={(e) => updateForm('ec', parseFloat(e.target.value) || 0)} step={0.1} min={0} />
              <NumberInput label="pH" value={form.ph} onChange={(e) => updateForm('ph', parseFloat(e.target.value) || 0)} step={0.1} min={0} max={14} />
              <NumberInput label="K Ratio" value={form.kRatio} onChange={(e) => updateForm('kRatio', parseFloat(e.target.value) || 0)} step={0.01} min={0} max={1} />
              <NumberInput label="Ca Ratio" value={form.caRatio} onChange={(e) => updateForm('caRatio', parseFloat(e.target.value) || 0)} step={0.01} min={0} max={1} />
              <NumberInput label="Mg Ratio" value={form.mgRatio} onChange={(e) => updateForm('mgRatio', parseFloat(e.target.value) || 0)} step={0.01} min={0} max={1} />
              <NumberInput label="N/K Ratio" value={form.nkRatio} onChange={(e) => updateForm('nkRatio', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
              <NumberInput label="NH4 Ratio" value={form.nh4Ratio} onChange={(e) => updateForm('nh4Ratio', parseFloat(e.target.value) || 0)} step={0.01} min={0} max={1} />
            </div>
          </div>

          {/* Macro / Other */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-3">Macro (mmol/L)</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <NumberInput label="P" value={form.p} onChange={(e) => updateForm('p', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
              <NumberInput label="Cl" value={form.cl} onChange={(e) => updateForm('cl', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
              <NumberInput label="Si" value={form.si} onChange={(e) => updateForm('si', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
              <NumberInput label="Min SO4" value={form.minSO4} onChange={(e) => updateForm('minSO4', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
            </div>
          </div>

          {/* Micro */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-3">Micro (umol/L)</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <NumberInput label="Fe" value={form.fe} onChange={(e) => updateForm('fe', parseFloat(e.target.value) || 0)} step={0.1} min={0} />
              <NumberInput label="Mn" value={form.mn} onChange={(e) => updateForm('mn', parseFloat(e.target.value) || 0)} step={0.1} min={0} />
              <NumberInput label="Zn" value={form.zn} onChange={(e) => updateForm('zn', parseFloat(e.target.value) || 0)} step={0.1} min={0} />
              <NumberInput label="Cu" value={form.cu} onChange={(e) => updateForm('cu', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
              <NumberInput label="B" value={form.b} onChange={(e) => updateForm('b', parseFloat(e.target.value) || 0)} step={0.1} min={0} />
              <NumberInput label="Mo" value={form.mo} onChange={(e) => updateForm('mo', parseFloat(e.target.value) || 0)} step={0.01} min={0} />
            </div>
          </div>

          {/* Save / Cancel */}
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => {
                setIsModalOpen(false);
                setEditingId(null);
                setForm({ ...EMPTY_PROFILE });
              }}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
            >
              {editingId ? 'Update Profile' : 'Create Profile'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default NutrientProfileManager;

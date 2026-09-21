/**
 * Suppliers Tab Component
 * Complete supplier management with CRUD operations
 */
import React, { useState } from 'react';
import {
  useSupplierList,
  useCreateSupplier,
  useUpdateSupplier,
  useDeleteSupplier,
  Supplier,
  SupplierType,
  SupplierStatus,
  CreateSupplierInput,
} from '../../../hooks/useSuppliers';
import SupplierApprovedSitesSection from '../components/SupplierApprovedSitesSection';
import {
  FormField,
  Modal,
  useToast,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import { useLocalConfirm } from '../../../hooks/useLocalConfirm';
import {
  Box,
  ChevronDown,
  Download,
  Globe,
  Mail,
  MapPin,
  Phone as PhoneIcon,
  Plus,
  Search as SearchIcon,
  Star as StarIcon,
  User,
  X,
} from 'lucide-react';

// Keys must be UPPERCASE to match GraphQL enum values
const typeColors: Record<string, string> = {
  EQUIPMENT: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  FEED: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  CHEMICAL: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  SERVICE: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  FRY: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  OTHER: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};

const typeLabels: Record<string, string> = {
  EQUIPMENT: 'Equipment',
  FEED: 'Feed',
  CHEMICAL: 'Chemical',
  SERVICE: 'Service',
  FRY: 'Fry',
  OTHER: 'Other',
};

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  INACTIVE: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  SUSPENDED: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  BLACKLISTED: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
};

const statusLabels: Record<string, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  SUSPENDED: 'Suspended',
  BLACKLISTED: 'Blacklisted',
};

interface SupplierFormData {
  // Basic Info
  name: string;
  code: string;
  type: SupplierType | '';
  status: SupplierStatus;
  // Contact
  contactPerson: string;
  email: string;
  phone: string;
  website: string;
  // Address
  street: string;
  city: string;
  country: string;
  // Products
  products: string[];
  // Rating
  rating: number | '';
  // Notes
  notes: string;
}

const initialFormData: SupplierFormData = {
  name: '',
  code: '',
  type: '',
  status: SupplierStatus.ACTIVE,
  contactPerson: '',
  email: '',
  phone: '',
  website: '',
  street: '',
  city: '',
  country: '',
  products: [],
  rating: '',
  notes: '',
};

// Collapsible Section Component
const CollapsibleSection: React.FC<{
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, isOpen, onToggle, children }) => (
  <div className="border border-gray-200 dark:border-gray-700 rounded-lg mb-4">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-t-lg"
    >
      <span className="font-medium text-gray-700 dark:text-gray-300">{title}</span>
      <ChevronDown
        className={`w-5 h-5 text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'transform rotate-180' : ''}`}
        aria-hidden="true"
      />
    </button>
    {isOpen && <div className="p-4 border-t border-gray-200 dark:border-gray-700">{children}</div>}
  </div>
);

// Star Rating Component
const StarRating: React.FC<{
  value: number | '';
  onChange: (value: number) => void;
}> = ({ value, onChange }) => {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <Button
          variant="ghost"
          key={star}
          type="button"
          onClick={() => onChange(star)}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
        >
          <StarIcon
            className={`w-6 h-6 ${
              (hover || value || 0) >= star ? 'text-warning-400' : 'text-gray-300'
            }`}
            aria-hidden="true"
          />
        </Button>
      ))}
      {value !== '' && (
        <Button
          variant="ghost"
          size="xs"
          className="ml-2"
          type="button"
          onClick={() => onChange(0)}
        >
          Clear
        </Button>
      )}
    </div>
  );
};

export const SuppliersTab: React.FC = () => {
  // API hooks
  const { data: suppliersData, isLoading, error, refetch } = useSupplierList();
  const createSupplier = useCreateSupplier();
  const updateSupplier = useUpdateSupplier();
  const deleteSupplierMutation = useDeleteSupplier();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<SupplierFormData>(initialFormData);
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [newProduct, setNewProduct] = useState('');

  // Collapsible sections state
  const [openSections, setOpenSections] = useState({
    basic: true,
    contact: true,
    address: false,
    products: false,
    rating: false,
    notes: false,
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Get suppliers from API
  const suppliers = suppliersData?.items || [];

  const filteredSuppliers = suppliers.filter((supplier) => {
    const matchesSearch =
      supplier.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (supplier.code?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
    const matchesType = selectedType === 'all' || supplier.type === selectedType;
    const matchesStatus = selectedStatus === 'all' || supplier.status === selectedStatus;
    return matchesSearch && matchesType && matchesStatus;
  });

  // Add product to list
  const handleAddProduct = () => {
    if (newProduct.trim()) {
      setFormData((prev) => ({
        ...prev,
        products: [...prev.products, newProduct.trim()],
      }));
      setNewProduct('');
    }
  };

  // Remove product from list
  const handleRemoveProduct = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      products: prev.products.filter((_, i) => i !== index),
    }));
  };

  const { confirm, dialog: confirmDialog } = useLocalConfirm();
  const { toast } = useToast();
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const errors: Record<string, string> = {};
    if (!formData.name) errors.name = 'Please enter a supplier name.';
    if (!formData.type) errors.type = 'Please select a supplier type.';
    // Backend sözleşmesi: code alanı String! — boş bırakılırsa frontend alanı
    // hiç göndermiyor ve GraphQL şema doğrulaması anlaşılmaz biçimde reddediyor
    // (`Field "code" of required type "String!" was not provided`, 2026-09-21).
    if (!formData.code.trim()) errors.code = 'Please enter a supplier code.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      // Base input fields (without status - status is only for updates)
      const baseInput: CreateSupplierInput = {
        name: formData.name,
        code: formData.code.trim(),
        type: formData.type as SupplierType,
        contactPerson: formData.contactPerson || undefined,
        email: formData.email || undefined,
        phone: formData.phone || undefined,
        website: formData.website || undefined,
        address: formData.street
          ? {
              street: formData.street,
              city: formData.city,
              country: formData.country,
            }
          : undefined,
        city: formData.city || undefined,
        country: formData.country || undefined,
        products: formData.products.length > 0 ? formData.products : undefined,
        rating: formData.rating !== '' ? Number(formData.rating) : undefined,
        notes: formData.notes || undefined,
      };

      if (editingId) {
        // For update: include status
        await updateSupplier.mutateAsync({
          id: editingId,
          ...baseInput,
          status: formData.status,
        });
      } else {
        // For create: status defaults to ACTIVE on backend
        await createSupplier.mutateAsync(baseInput);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setFieldErrors({});
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save supplier:', err);
      toast({ title: 'Failed to save supplier. Please try again.', variant: 'error' });
    }
  };

  const handleEdit = (supplier: Supplier) => {
    setEditingId(supplier.id);
    setFormData({
      name: supplier.name,
      code: supplier.code || '',
      type: supplier.type,
      status: supplier.status,
      contactPerson: supplier.contactPerson || '',
      email: supplier.email || '',
      phone: supplier.phone || '',
      website: supplier.website || '',
      street: supplier.address?.street || '',
      city: supplier.city || supplier.address?.city || '',
      country: supplier.country || supplier.address?.country || '',
      products: supplier.products || [],
      rating: supplier.rating ?? '',
      notes: supplier.notes || '',
    });
    // Open all sections when editing
    setOpenSections({
      basic: true,
      contact: true,
      address: true,
      products: true,
      rating: true,
      notes: true,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (
      await confirm({
        title: 'Delete this supplier?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      })
    ) {
      try {
        await deleteSupplierMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete supplier:', err);
        toast({ title: 'Failed to delete supplier. Please try again.', variant: 'error' });
      }
    }
  };

  const openAddModal = () => {
    setEditingId(null);
    setFormData(initialFormData);
    setFieldErrors({});
    setOpenSections({
      basic: true,
      contact: true,
      address: false,
      products: false,
      rating: false,
      notes: false,
    });
    setIsModalOpen(true);
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              placeholder="Search suppliers..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent"
            />
            <SearchIcon
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <Select
            aria-label="Type filter"
            fullWidth={false}
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            options={[
              { value: 'all', label: 'All Types' },
              ...Object.entries(typeLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
          <Select
            aria-label="Status filter"
            fullWidth={false}
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            options={[
              { value: 'all', label: 'All Statuses' },
              ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <Button variant="primary" onClick={openAddModal}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Supplier
        </Button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-error-50 dark:bg-error-900/20 rounded-lg border border-error-200 dark:border-error-800">
          <p className="text-error-600 dark:text-error-400">
            Failed to load suppliers. Please try again.
          </p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Suppliers Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSuppliers.map((supplier) => (
            <div
              key={supplier.id}
              className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow"
            >
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {supplier.name}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{supplier.code}</p>
                  </div>
                  <div className="flex flex-col gap-1 items-end">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeColors[supplier.type] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                    >
                      {typeLabels[supplier.type] || supplier.type}
                    </span>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[supplier.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                    >
                      {statusLabels[supplier.status] || supplier.status}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  {/* Location */}
                  {(supplier.city || supplier.country || supplier.address?.street) && (
                    <div className="flex items-start text-sm text-gray-600 dark:text-gray-400">
                      <MapPin
                        className="w-4 h-4 mr-2 mt-0.5 text-gray-400 dark:text-gray-500 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        {[
                          supplier.address?.street,
                          supplier.city || supplier.address?.city,
                          supplier.country || supplier.address?.country,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </div>
                  )}

                  {/* Contact Person */}
                  {supplier.contactPerson && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <User
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {supplier.contactPerson}
                    </div>
                  )}

                  {/* Email */}
                  {supplier.email && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <Mail
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {supplier.email}
                    </div>
                  )}

                  {/* Phone */}
                  {supplier.phone && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <PhoneIcon
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {supplier.phone}
                    </div>
                  )}

                  {/* Website */}
                  {supplier.website && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <Globe
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      <a
                        href={supplier.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info-600 dark:text-info-400 hover:underline truncate"
                      >
                        {supplier.website.replace(/^https?:\/\//, '')}
                      </a>
                    </div>
                  )}

                  {/* Products */}
                  {supplier.products && supplier.products.length > 0 && (
                    <div className="flex items-start text-sm text-gray-600 dark:text-gray-400">
                      <Box
                        className="w-4 h-4 mr-2 mt-0.5 text-gray-400 dark:text-gray-500 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <div className="flex flex-wrap gap-1">
                        {supplier.products.slice(0, 3).map((product, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs"
                          >
                            {product}
                          </span>
                        ))}
                        {supplier.products.length > 3 && (
                          <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs">
                            +{supplier.products.length - 3}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Rating */}
                  {supplier.rating !== undefined && supplier.rating !== null && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <div className="flex items-center">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <StarIcon
                            key={star}
                            className={`w-4 h-4 ${star <= (supplier.rating || 0) ? 'text-warning-400' : 'text-gray-300'}`}
                            fill="currentColor"
                            aria-hidden="true"
                          />
                        ))}
                        <span className="ml-1 text-gray-500 dark:text-gray-400">
                          ({supplier.rating})
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 rounded-b-lg flex justify-between items-center">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {supplier.paymentTerms ? `Payment: ${supplier.paymentTerms}` : ''}
                </span>
                <div className="flex space-x-2">
                  <Button variant="ghost" onClick={() => handleEdit(supplier)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => handleDelete(supplier.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredSuppliers.length === 0 && (
        <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <Download
            className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            No suppliers found
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Add your first supplier to get started.
          </p>
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Supplier' : 'Add Supplier'}
        size="lg"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            {/* Section 1: Basic Info */}
            <CollapsibleSection
              title="Basic Information"
              isOpen={openSections.basic}
              onToggle={() => toggleSection('basic')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Supplier Name *
                  </label>
                  <FormField error={formData.name ? undefined : fieldErrors.name} className="mb-0">
                    <Input
                      fullWidth
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    />
                  </FormField>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Code *
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.code}
                    error={formData.code.trim() ? undefined : fieldErrors.code}
                    onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                <Select
                  label="Type"
                  required
                  placeholder="Select Type"
                  value={formData.type}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, type: e.target.value as SupplierType }))
                  }
                  error={formData.type ? undefined : fieldErrors.type}
                  options={Object.entries(typeLabels).map(([value, label]) => ({ value, label }))}
                />
                <Select
                  label="Status"
                  value={formData.status}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, status: e.target.value as SupplierStatus }))
                  }
                  options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
                />
              </div>
            </CollapsibleSection>

            {/* Section 2: Contact Info */}
            <CollapsibleSection
              title="Contact Information"
              isOpen={openSections.contact}
              onToggle={() => toggleSection('contact')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Contact Person
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.contactPerson}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, contactPerson: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Email
                  </label>
                  <Input
                    fullWidth
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Phone
                  </label>
                  <Input
                    fullWidth
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData((prev) => ({ ...prev, phone: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Website
                  </label>
                  <Input
                    fullWidth
                    type="url"
                    value={formData.website}
                    onChange={(e) => setFormData((prev) => ({ ...prev, website: e.target.value }))}
                    placeholder="https://..."
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 3: Address */}
            <CollapsibleSection
              title="Address"
              isOpen={openSections.address}
              onToggle={() => toggleSection('address')}
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Street Address
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.street}
                  onChange={(e) => setFormData((prev) => ({ ...prev, street: e.target.value }))}
                  placeholder="Street, Building, No."
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    City
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.city}
                    onChange={(e) => setFormData((prev) => ({ ...prev, city: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Country
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.country}
                    onChange={(e) => setFormData((prev) => ({ ...prev, country: e.target.value }))}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Products */}
            <CollapsibleSection
              title="Products Supplied"
              isOpen={openSections.products}
              onToggle={() => toggleSection('products')}
            >
              <div className="space-y-3">
                {/* Product List */}
                {formData.products.length > 0 && (
                  <div className="space-y-2">
                    {formData.products.map((product, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-md"
                      >
                        <span className="flex-1 text-sm">{product}</span>
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => handleRemoveProduct(index)}
                        >
                          <X className="w-4 h-4" aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add Product Input */}
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={newProduct}
                    onChange={(e) => setNewProduct(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddProduct();
                      }
                    }}
                    placeholder="Enter product name..."
                  />
                  <button
                    type="button"
                    onClick={handleAddProduct}
                    className="px-4 py-2 bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300 rounded-md hover:bg-info-200 dark:hover:bg-info-800/60 transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 5: Rating */}
            <CollapsibleSection
              title="Rating"
              isOpen={openSections.rating}
              onToggle={() => toggleSection('rating')}
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Supplier Rating (1-5)
                </label>
                <StarRating
                  value={formData.rating}
                  onChange={(value) =>
                    setFormData((prev) => ({ ...prev, rating: value === 0 ? '' : value }))
                  }
                />
              </div>
            </CollapsibleSection>

            {/* Section 6: Notes */}
            <CollapsibleSection
              title="Additional Information"
              isOpen={openSections.notes}
              onToggle={() => toggleSection('notes')}
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Notes
                </label>
                <Textarea
                  fullWidth
                  value={formData.notes}
                  onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                  rows={4}
                  placeholder="Additional notes about the supplier..."
                />
              </div>
            </CollapsibleSection>

            {/*
                    Approved sites picker (Scope A 4.4.2 — wires the
                    setSupplierApprovedSites mutation backend shipped
                    in PR #148). Symmetric to SiteContactsSection
                    (PR #155): standalone editable list with its own
                    submit, hidden in CREATE mode (no supplierId yet),
                    read-only when the operator lacks the permission.

                    Surfaced OUTSIDE the form's onSubmit so the
                    approved-sites swap doesn't ride the supplier-
                    update transaction; the two concerns commit
                    independently. Folding into a single submit is a
                    Phase 4.4.2 follow-up that requires backend
                    createSupplier/updateSupplier to gain inline
                    `approvedSiteIds[]` first.
                  */}
            <SupplierApprovedSitesSection supplierId={editingId ?? undefined} />
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 sm:flex sm:flex-row-reverse">
            <Button
              variant="primary"
              size="lg"
              className="justify-center sm:ml-3 sm:w-auto sm:text-sm"
              type="submit"
              disabled={createSupplier.isPending || updateSupplier.isPending}
            >
              {(createSupplier.isPending || updateSupplier.isPending) && (
                <Spinner size="sm" color="white" className="-ml-1 mr-2" />
              )}
              {editingId ? 'Update' : 'Create'}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="mt-3 justify-center sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
              type="button"
              onClick={() => setIsModalOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  );
};

export default SuppliersTab;

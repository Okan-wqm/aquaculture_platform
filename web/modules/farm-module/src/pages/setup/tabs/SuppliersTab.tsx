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

// Keys must be UPPERCASE to match GraphQL enum values
const typeColors: Record<string, string> = {
  EQUIPMENT: 'bg-blue-100 text-blue-800',
  FEED: 'bg-green-100 text-green-800',
  CHEMICAL: 'bg-purple-100 text-purple-800',
  SERVICE: 'bg-orange-100 text-orange-800',
  FRY: 'bg-cyan-100 text-cyan-800',
  OTHER: 'bg-gray-100 text-gray-800',
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
  ACTIVE: 'bg-green-100 text-green-800',
  INACTIVE: 'bg-gray-100 text-gray-800',
  SUSPENDED: 'bg-yellow-100 text-yellow-800',
  BLACKLISTED: 'bg-red-100 text-red-800',
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
  <div className="border border-gray-200 rounded-lg mb-4">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-t-lg"
    >
      <span className="font-medium text-gray-700">{title}</span>
      <svg
        className={`w-5 h-5 text-gray-500 transition-transform ${isOpen ? 'transform rotate-180' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    {isOpen && <div className="p-4 border-t border-gray-200">{children}</div>}
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
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
          className="focus:outline-none"
        >
          <svg
            className={`w-6 h-6 ${
              (hover || value || 0) >= star ? 'text-yellow-400' : 'text-gray-300'
            }`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        </button>
      ))}
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange(0)}
          className="ml-2 text-xs text-gray-500 hover:text-gray-700"
        >
          Clear
        </button>
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
    setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Get suppliers from API
  const suppliers = suppliersData?.items || [];

  const filteredSuppliers = suppliers.filter(supplier => {
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
      setFormData(prev => ({
        ...prev,
        products: [...prev.products, newProduct.trim()],
      }));
      setNewProduct('');
    }
  };

  // Remove product from list
  const handleRemoveProduct = (index: number) => {
    setFormData(prev => ({
      ...prev,
      products: prev.products.filter((_, i) => i !== index),
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Base input fields (without status - status is only for updates)
      const baseInput: CreateSupplierInput = {
        name: formData.name,
        code: formData.code || undefined,
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
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save supplier:', err);
      alert('Failed to save supplier. Please try again.');
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
    if (confirm('Are you sure you want to delete this supplier?')) {
      try {
        await deleteSupplierMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete supplier:', err);
        alert('Failed to delete supplier. Please try again.');
      }
    }
  };

  const openAddModal = () => {
    setEditingId(null);
    setFormData(initialFormData);
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
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Types</option>
            {Object.entries(typeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Statuses</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={openAddModal}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Supplier
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load suppliers. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Suppliers Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSuppliers.map((supplier) => (
            <div key={supplier.id} className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{supplier.name}</h3>
                    <p className="text-sm text-gray-500">{supplier.code}</p>
                  </div>
                  <div className="flex flex-col gap-1 items-end">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeColors[supplier.type] || 'bg-gray-100 text-gray-800'}`}>
                      {typeLabels[supplier.type] || supplier.type}
                    </span>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[supplier.status] || 'bg-gray-100 text-gray-800'}`}>
                      {statusLabels[supplier.status] || supplier.status}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  {/* Location */}
                  {(supplier.city || supplier.country || supplier.address?.street) && (
                    <div className="flex items-start text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 mt-0.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      </svg>
                      <span>
                        {[supplier.address?.street, supplier.city || supplier.address?.city, supplier.country || supplier.address?.country]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </div>
                  )}

                  {/* Contact Person */}
                  {supplier.contactPerson && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      {supplier.contactPerson}
                    </div>
                  )}

                  {/* Email */}
                  {supplier.email && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      {supplier.email}
                    </div>
                  )}

                  {/* Phone */}
                  {supplier.phone && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                      {supplier.phone}
                    </div>
                  )}

                  {/* Website */}
                  {supplier.website && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                      </svg>
                      <a href={supplier.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate">
                        {supplier.website.replace(/^https?:\/\//, '')}
                      </a>
                    </div>
                  )}

                  {/* Products */}
                  {supplier.products && supplier.products.length > 0 && (
                    <div className="flex items-start text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 mt-0.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                      </svg>
                      <div className="flex flex-wrap gap-1">
                        {supplier.products.slice(0, 3).map((product, idx) => (
                          <span key={idx} className="px-2 py-0.5 bg-gray-100 rounded text-xs">{product}</span>
                        ))}
                        {supplier.products.length > 3 && (
                          <span className="px-2 py-0.5 bg-gray-200 rounded text-xs">+{supplier.products.length - 3}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Rating */}
                  {supplier.rating !== undefined && supplier.rating !== null && (
                    <div className="flex items-center text-sm text-gray-600">
                      <div className="flex items-center">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <svg
                            key={star}
                            className={`w-4 h-4 ${star <= (supplier.rating || 0) ? 'text-yellow-400' : 'text-gray-300'}`}
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        ))}
                        <span className="ml-1 text-gray-500">({supplier.rating})</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 rounded-b-lg flex justify-between items-center">
                <span className="text-xs text-gray-500">
                  {supplier.paymentTerms ? `Payment: ${supplier.paymentTerms}` : ''}
                </span>
                <div className="flex space-x-2">
                  <button onClick={() => handleEdit(supplier)} className="text-blue-600 hover:text-blue-800 text-sm font-medium">Edit</button>
                  <button onClick={() => handleDelete(supplier.id)} className="text-red-600 hover:text-red-800 text-sm font-medium">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredSuppliers.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No suppliers found</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first supplier to get started.</p>
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:max-w-2xl sm:w-full max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">
                    {editingId ? 'Edit Supplier' : 'Add Supplier'}
                  </h3>

                  {/* Section 1: Basic Info */}
                  <CollapsibleSection
                    title="Basic Information"
                    isOpen={openSections.basic}
                    onToggle={() => toggleSection('basic')}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Supplier Name *</label>
                        <input
                          type="text"
                          required
                          value={formData.name}
                          onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Code</label>
                        <input
                          type="text"
                          value={formData.code}
                          onChange={e => setFormData(prev => ({ ...prev, code: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Type *</label>
                        <select
                          required
                          value={formData.type}
                          onChange={e => setFormData(prev => ({ ...prev, type: e.target.value as SupplierType }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select Type</option>
                          {Object.entries(typeLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Status</label>
                        <select
                          value={formData.status}
                          onChange={e => setFormData(prev => ({ ...prev, status: e.target.value as SupplierStatus }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          {Object.entries(statusLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 2: Contact Info */}
                  <CollapsibleSection
                    title="Contact Information"
                    isOpen={openSections.contact}
                    onToggle={() => toggleSection('contact')}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Contact Person</label>
                        <input
                          type="text"
                          value={formData.contactPerson}
                          onChange={e => setFormData(prev => ({ ...prev, contactPerson: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Email</label>
                        <input
                          type="email"
                          value={formData.email}
                          onChange={e => setFormData(prev => ({ ...prev, email: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Phone</label>
                        <input
                          type="tel"
                          value={formData.phone}
                          onChange={e => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Website</label>
                        <input
                          type="url"
                          value={formData.website}
                          onChange={e => setFormData(prev => ({ ...prev, website: e.target.value }))}
                          placeholder="https://..."
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
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
                      <label className="block text-sm font-medium text-gray-700">Street Address</label>
                      <input
                        type="text"
                        value={formData.street}
                        onChange={e => setFormData(prev => ({ ...prev, street: e.target.value }))}
                        placeholder="Street, Building, No."
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">City</label>
                        <input
                          type="text"
                          value={formData.city}
                          onChange={e => setFormData(prev => ({ ...prev, city: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Country</label>
                        <input
                          type="text"
                          value={formData.country}
                          onChange={e => setFormData(prev => ({ ...prev, country: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
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
                            <div key={index} className="flex items-center gap-2 bg-gray-50 p-2 rounded-md">
                              <span className="flex-1 text-sm">{product}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveProduct(index)}
                                className="text-red-500 hover:text-red-700"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add Product Input */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newProduct}
                          onChange={e => setNewProduct(e.target.value)}
                          onKeyPress={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddProduct();
                            }
                          }}
                          placeholder="Enter product name..."
                          className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                        <button
                          type="button"
                          onClick={handleAddProduct}
                          className="px-4 py-2 bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200 transition-colors"
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
                      <label className="block text-sm font-medium text-gray-700 mb-2">Supplier Rating (1-5)</label>
                      <StarRating
                        value={formData.rating}
                        onChange={(value) => setFormData(prev => ({ ...prev, rating: value === 0 ? '' : value }))}
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
                      <label className="block text-sm font-medium text-gray-700">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={4}
                        placeholder="Additional notes about the supplier..."
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </CollapsibleSection>
                </div>

                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={createSupplier.isPending || updateSupplier.isPending}
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
                  >
                    {(createSupplier.isPending || updateSupplier.isPending) && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    )}
                    {editingId ? 'Update' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SuppliersTab;

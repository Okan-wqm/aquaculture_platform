import { SiteContact } from '../entities/site-contact.entity';
import { Site } from '../entities/site.entity';

export function siteAuditSnapshot(site: Site): Record<string, unknown> {
  return {
    id: site.id,
    tenantId: site.tenantId,
    name: site.name,
    code: site.code,
    lokalitetsnummer: site.lokalitetsnummer,
    organisationNumberOverride: site.organisationNumberOverride,
    type: site.type,
    description: site.description,
    location: site.location,
    monitoringRadiusM: site.monitoringRadiusM,
    monitoringArea: site.monitoringArea,
    monitoringLocationRevision: site.monitoringLocationRevision,
    address: site.address,
    city: site.city,
    country: site.country,
    region: site.region,
    timezone: site.timezone,
    areaM2: site.areaM2,
    waterCapacityM3: site.waterCapacityM3,
    maxBiomassKg: site.maxBiomassKg,
    contactEmail: site.contactEmail,
    contactPhone: site.contactPhone,
    siteManager: site.siteManager,
    facilities: site.facilities,
    settings: site.settings,
    status: site.status,
    isActive: site.isActive,
    notes: site.notes,
    metadata: site.metadata,
    createdBy: site.createdBy,
    updatedBy: site.updatedBy,
    version: site.version,
    isDeleted: site.isDeleted,
    deletedAt: site.deletedAt,
    deletedBy: site.deletedBy,
  };
}

export function siteContactAuditSnapshot(contact: SiteContact): Record<string, unknown> {
  return {
    id: contact.id,
    tenantId: contact.tenantId,
    siteId: contact.siteId,
    name: contact.name,
    role: contact.role,
    email: contact.email,
    phone: contact.phone,
    isPrimary: contact.isPrimary,
    createdBy: contact.createdBy,
  };
}

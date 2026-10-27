/**
 * Department inputs through the SAME pipe every service mounts (create-service-app:
 * whitelist + forbidNonWhitelisted + transform).
 *
 * A GraphQL input property that carries only `@Field` is "not whitelisted": the pipe
 * refuses a request that sends it ("property X should not exist") while the schema
 * advertises it. Both department inputs were entirely undecorated, so registering or
 * editing a department through the API failed on every field — and adding ONE decorated
 * field to such a class would have made it worse (the rest would stop being accepted).
 * These specs pin the behaviour that matters: what the UI sends is accepted, and what the
 * database could not hold (a code longer than varchar(20)) is refused at the door.
 */
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { CreateDepartmentInput } from '../dto/create-department.input';
import { UpdateDepartmentInput } from '../dto/update-department.input';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const bodyOf = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
  data: 'input',
});

const departmentId = '3f1c2b8e-9d4a-4c61-8f0e-5a7b2d9c1e44';
const siteId = '7a2e6c10-1b3d-4f8a-9c55-0e6d1f2a3b4c';

describe('CreateDepartmentInput through the global pipe', () => {
  it('accepts the minimal input the Departments form sends', async () => {
    await expect(
      pipe.transform({ name: 'Seed room', code: 'SEED' }, bodyOf(CreateDepartmentInput)),
    ).resolves.toMatchObject({ name: 'Seed room', code: 'SEED' });
  });

  it('accepts every field, including the owning module', async () => {
    const input = {
      name: 'Control room',
      code: 'CTL',
      description: 'Automation',
      siteId,
      moduleCode: OWNER_MODULE.SENSOR,
      parentDepartmentId: departmentId,
      managerId: departmentId,
      budgetCode: 'BC-1',
      costCenter: 'CC-1',
    };

    await expect(pipe.transform(input, bodyOf(CreateDepartmentInput))).resolves.toMatchObject(
      input,
    );
  });

  it('refuses a code the database cannot hold (varchar(20))', async () => {
    await expect(
      pipe.transform({ name: 'Too long', code: 'X'.repeat(21) }, bodyOf(CreateDepartmentInput)),
    ).rejects.toThrow();
  });

  it('refuses a missing name or code', async () => {
    await expect(
      pipe.transform({ code: 'ONLY-CODE' }, bodyOf(CreateDepartmentInput)),
    ).rejects.toThrow();
    await expect(
      pipe.transform({ name: 'Only name' }, bodyOf(CreateDepartmentInput)),
    ).rejects.toThrow();
  });

  it('accepts hr: an HR-owned unit no longer has to be stored as company-wide (HR-MEDIUM-064)', async () => {
    await expect(
      pipe.transform(
        { name: 'People', code: 'PPL', moduleCode: OWNER_MODULE.HR },
        bodyOf(CreateDepartmentInput),
      ),
    ).resolves.toMatchObject({ moduleCode: 'hr' });
  });

  it('refuses a module the schema does not know', async () => {
    await expect(
      pipe.transform({ name: 'N', code: 'C', moduleCode: 'alert' }, bodyOf(CreateDepartmentInput)),
    ).rejects.toThrow();
  });

  it('refuses a property the input does not declare', async () => {
    await expect(
      pipe.transform({ name: 'N', code: 'C', isDeleted: true }, bodyOf(CreateDepartmentInput)),
    ).rejects.toThrow();
  });
});

describe('UpdateDepartmentInput through the global pipe', () => {
  it('accepts a partial update that moves a department to another module', async () => {
    await expect(
      pipe.transform(
        { id: departmentId, moduleCode: OWNER_MODULE.FARM },
        bodyOf(UpdateDepartmentInput),
      ),
    ).resolves.toMatchObject({ id: departmentId, moduleCode: OWNER_MODULE.FARM });
  });

  it('accepts an explicit null to make a department company-wide again', async () => {
    await expect(
      pipe.transform({ id: departmentId, moduleCode: null }, bodyOf(UpdateDepartmentInput)),
    ).resolves.toMatchObject({ id: departmentId, moduleCode: null });
  });

  it('accepts deactivation and soft delete flags', async () => {
    await expect(
      pipe.transform(
        { id: departmentId, isActive: false, isDeleted: true },
        bodyOf(UpdateDepartmentInput),
      ),
    ).resolves.toMatchObject({ isActive: false, isDeleted: true });
  });

  it('refuses a missing or malformed id', async () => {
    await expect(
      pipe.transform({ name: 'No id' }, bodyOf(UpdateDepartmentInput)),
    ).rejects.toThrow();
    await expect(
      pipe.transform({ id: 'not-a-uuid' }, bodyOf(UpdateDepartmentInput)),
    ).rejects.toThrow();
  });

  it('refuses a code the database cannot hold (varchar(20))', async () => {
    await expect(
      pipe.transform({ id: departmentId, code: 'X'.repeat(21) }, bodyOf(UpdateDepartmentInput)),
    ).rejects.toThrow();
  });
});

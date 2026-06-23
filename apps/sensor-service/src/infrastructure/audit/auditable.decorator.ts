import 'reflect-metadata';

const AUDITABLE_KEY = Symbol('AUDITABLE');

export function Auditable(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AUDITABLE_KEY, true, target);
  };
}

/**
 * Reports whether a class was marked with {@link Auditable}.
 *
 * The parameter is `object` — the exact type `Reflect.getMetadata` accepts —
 * rather than the unsafe bare `Function`. A class constructor is an object, so
 * callers pass the entity class directly; TypeORM's `metadata.target`
 * (`Function | string`) narrows to a function via `typeof`, which is assignable
 * to `object`.
 */
export function isAuditable(target: object): boolean {
  return Reflect.getMetadata(AUDITABLE_KEY, target) === true;
}

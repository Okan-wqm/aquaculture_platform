import 'reflect-metadata';

const AUDITABLE_KEY = Symbol('AUDITABLE');

export function Auditable(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AUDITABLE_KEY, true, target);
  };
}

export function isAuditable(target: Function): boolean {
  return Reflect.getMetadata(AUDITABLE_KEY, target) === true;
}

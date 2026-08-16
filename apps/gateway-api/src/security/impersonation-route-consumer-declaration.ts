import type {
  ImpersonationModule,
  ImpersonationOperationAuthority,
} from '@aquaculture/shared-contracts';

export type ImpersonationGatewayConsumer =
  | 'federated-graphql'
  | 'marine-render'
  | 'sensor-mqtt-status'
  | 'sensor-export';

export interface ImpersonationRestOperationDeclaration {
  readonly serviceName: string;
  readonly method: 'GET' | 'POST';
  readonly pathTemplate: string;
  readonly authority: ImpersonationOperationAuthority;
  readonly module: ImpersonationModule;
}

export interface ImpersonationGatewayRouteConsumerDeclaration {
  readonly method: 'GET' | 'POST';
  readonly routeTemplate: string;
  readonly content: 'empty' | 'json-object';
  readonly query: 'forbidden' | 'canonical';
  readonly consumer: ImpersonationGatewayConsumer;
  readonly outwardRestOperation?: ImpersonationRestOperationDeclaration;
}

export function defineImpersonationRouteConsumer<
  const TDeclaration extends ImpersonationGatewayRouteConsumerDeclaration,
>(declaration: TDeclaration): Readonly<TDeclaration> {
  return Object.freeze(declaration);
}

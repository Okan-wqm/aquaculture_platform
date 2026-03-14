export class GetPlansQuery {
  constructor(
    /** When true, returns only public and active plans (for tenant-facing listing) */
    public readonly publicOnly: boolean = true,
  ) {}
}

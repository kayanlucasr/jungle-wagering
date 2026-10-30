import { Injectable, type CanActivate } from '@nestjs/common';

/** Explicit extension point for a future OIDC/JWKS guard. This authenticates nobody:
 * financial HTTP remains open for the local challenge. Never infer a trusted provider. */
@Injectable()
export class NoopProviderIdentityGuard implements CanActivate {
  canActivate(): boolean { return true; }
}

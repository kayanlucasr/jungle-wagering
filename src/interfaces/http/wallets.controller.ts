import { Body, Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { NoopProviderIdentityGuard } from './noop-provider-identity.guard';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { FinancialService } from '../../application/financial/financial-service';
import { FinancialQueryService } from '../../application/financial/financial-query-service';
import { createWalletDto, identifier, ledgerQuery, noBody, noQuery } from './financial-dtos';
import { walletResponse, ledgerEntryResponse, reconciliationResponse } from './financial-responses';
import { HttpMetrics } from './http-metrics';
import { JsonLogger } from '../../infrastructure/observability/json-logger';

@Controller('wallets')
@UseGuards(NoopProviderIdentityGuard)
export class WalletsController {
  constructor(@Inject(FinancialService) private readonly commands: FinancialService,
    @Inject(FinancialQueryService) private readonly queries: FinancialQueryService,
    @Inject(HttpMetrics) private readonly metrics: HttpMetrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger) {}

  @Post()
  async create(@Body() body: unknown, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    noQuery(query);
    const wallet = await this.commands.openWallet({ id: randomUUID(), ...createWalletDto(body) },
      { correlationId: String(res.getHeader('x-correlation-id')) });
    res.locals['financialTrace'] = { walletId: wallet.id };
    return walletResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') rawId: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    noQuery(query);
    const walletId = identifier(rawId, 'walletId');
    res.locals['financialTrace'] = { walletId };
    return walletResponse(await this.queries.wallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') rawId: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const walletId = identifier(rawId, 'walletId');
    const { limit, cursor } = ledgerQuery(query);
    res.locals['financialTrace'] = { walletId };
    const result = await this.queries.ledger(walletId, limit, cursor);
    return { items: result.items.map(ledgerEntryResponse), nextCursor: result.nextCursor };
  }

  @Post(':walletId/reconciliation')
  async reconciliation(@Param('walletId') rawId: string, @Body() body: unknown, @Query() query: unknown,
    @Res({ passthrough: true }) res: Response) {
    noQuery(query); noBody(body);
    const walletId = identifier(rawId, 'walletId');
    res.locals['financialTrace'] = { walletId };
    const result = await this.commands.reconcile(walletId);
    this.metrics.reconciliationCompleted(result.consistent);
    if (!result.consistent) this.logger.write('warn', 'financial_reconciliation_inconsistent', {
      walletId, correlationId: res.getHeader('x-correlation-id')?.toString() ?? 'unavailable',
      requestId: res.getHeader('x-request-id')?.toString() ?? 'unavailable',
    });
    res.status(200);
    return reconciliationResponse(result);
  }
}

import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { FinancialService } from '../../application/financial/financial-service';
import { FinancialQueryService } from '../../application/financial/financial-query-service';
import { idempotencyKey, identifier, noQuery, submitTransactionDto } from './financial-dtos';
import { submissionResponse, submissionStatus, transactionResponse } from './financial-responses';

@Controller()
export class TransactionsController {
  constructor(@Inject(FinancialService) private readonly commands: FinancialService,
    @Inject(FinancialQueryService) private readonly queries: FinancialQueryService) {}

  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Query() query: unknown, @Req() req: Request,
    @Res({ passthrough: true }) res: Response) {
    noQuery(query);
    const key = idempotencyKey(req);
    const dto = submitTransactionDto(body);
    res.locals['financialTrace'] = { walletId: dto.walletId, providerId: dto.providerId };
    const result = await this.commands.submit({ ...dto, idempotencyKey: key });
    res.locals['financialTrace'] = { walletId: dto.walletId, providerId: dto.providerId, transactionId: result.transactionId };
    res.status(submissionStatus(result));
    return submissionResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') rawId: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    noQuery(query);
    const transactionId = identifier(rawId, 'transactionId');
    res.locals['financialTrace'] = { transactionId };
    return transactionResponse(await this.queries.transaction(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async external(@Param('providerId') rawProvider: string, @Param('externalTransactionId') rawExternal: string,
    @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    noQuery(query);
    const providerId = identifier(rawProvider, 'providerId');
    const externalId = identifier(rawExternal, 'externalTransactionId');
    const transaction = await this.queries.externalTransaction(providerId, externalId);
    res.locals['financialTrace'] = { providerId, walletId: transaction.walletId, transactionId: transaction.id };
    return transactionResponse(transaction);
  }
}

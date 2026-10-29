import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { SqsService } from '../../infrastructure/messaging/sqs.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SqsService) private readonly sqs: SqsService,
  ) {}

  @Get('live')
  live() { return { status: 'ok' as const }; }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.allSettled([
      this.database.checkReady(), this.sqs.checkReady(),
    ]);
    const dependencies = {
      postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (postgres.status === 'rejected' || sqs.status === 'rejected') {
      throw new ServiceUnavailableException({ status: 'unavailable', dependencies });
    }
    return { status: 'ok', dependencies };
  }
}

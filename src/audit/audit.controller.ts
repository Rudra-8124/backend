import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';
import { AuditService, AuditVerificationResult } from './audit.service';
import { QueryAuditLogsDto, VerifyAuditChainDto } from './dto/query-audit-logs.dto';

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RateLimit('standard')
  @ApiOperation({
    summary: 'Query append-only audit logs with filters and keyset pagination (Admin only)',
  })
  @ApiResponse({ status: 200, description: 'Audit logs matching criteria' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async getLogs(@Query() filter: QueryAuditLogsDto) {
    return this.auditService.getLogs(filter);
  }

  @Get('verify')
  @RateLimit('standard')
  @ApiOperation({
    summary: 'Verify hash-chain cryptographic integrity of a monthly partition (Admin only)',
    description:
      'Traverses the partition audit log sequentially to prove that no rows were inserted, deleted, or mutated.',
  })
  @ApiResponse({ status: 200, description: 'Verification result' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async verifyChain(@Query() dto: VerifyAuditChainDto): Promise<AuditVerificationResult> {
    const now = new Date();
    const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const partitionMonth = dto.partition_month || currentMonth;
    return this.auditService.verifyPartitionChain(partitionMonth);
  }
}

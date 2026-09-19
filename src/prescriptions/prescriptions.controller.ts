import { Controller, Post, Get, Body, Param, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { PrescriptionsService } from './prescriptions.service';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';

@ApiTags('Prescriptions')
@Controller()
@ApiBearerAuth('access-token')
export class PrescriptionsController {
  constructor(private readonly prescriptionsService: PrescriptionsService) {}

  @Post('consultations/:id/prescriptions')
  @Roles('doctor')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('standard')
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique idempotency key',
    required: true,
  })
  @ApiOperation({
    summary:
      'Issue a prescription (Doctor only, only for IN_PROGRESS/COMPLETED consultations, encrypted with AES-256-GCM, audited)',
  })
  async createPrescription(
    @CurrentUser() user: RequestUser,
    @Param('id') consultationId: string,
    @Body() dto: CreatePrescriptionDto,
    @Req() req: FastifyRequest,
  ) {
    const reqInfo = {
      ip: req.ip,
      requestId: req.headers['x-request-id'] as string,
    };
    return this.prescriptionsService.createPrescription(user.userId, consultationId, dto, reqInfo);
  }

  @Get('consultations/:id/prescriptions')
  @RateLimit('standard')
  @ApiOperation({
    summary:
      'Get prescriptions for a consultation (Assigned doctor, Patient owner, Admin; decrypted in-memory, audited)',
  })
  async getConsultationPrescriptions(
    @CurrentUser() user: RequestUser,
    @Param('id') consultationId: string,
    @Req() req: FastifyRequest,
  ) {
    const reqInfo = {
      ip: req.ip,
      requestId: req.headers['x-request-id'] as string,
    };
    return this.prescriptionsService.getConsultationPrescriptions(
      user.userId,
      user.role,
      consultationId,
      reqInfo,
    );
  }

  @Get('prescriptions/:id')
  @RateLimit('standard')
  @ApiOperation({
    summary:
      'Get single prescription by ID (Assigned doctor, Patient owner, Admin; decrypted in-memory, audited)',
  })
  async getPrescriptionById(
    @CurrentUser() user: RequestUser,
    @Param('id') prescriptionId: string,
    @Req() req: FastifyRequest,
  ) {
    const reqInfo = {
      ip: req.ip,
      requestId: req.headers['x-request-id'] as string,
    };
    return this.prescriptionsService.getPrescriptionById(
      user.userId,
      user.role,
      prescriptionId,
      reqInfo,
    );
  }
}

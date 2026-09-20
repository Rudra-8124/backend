import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { ConsultationsService } from './consultations.service';
import { BookConsultationDto } from './dto/book-consultation.dto';
import { CompleteConsultationDto } from './dto/complete-consultation.dto';
import { CancelConsultationDto } from './dto/cancel-consultation.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';

@ApiTags('Consultations')
@Controller('consultations')
@ApiBearerAuth('access-token')
export class ConsultationsController {
  constructor(private readonly consultationsService: ConsultationsService) {}

  @Post()
  @Roles('patient')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('standard')
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique idempotency key for state-changing request',
    required: true,
  })
  @ApiHeader({
    name: 'traceparent',
    description: 'W3C distributed trace context parent header',
    required: false,
  })
  @ApiOperation({
    summary: 'Book a consultation slot (Patient only, atomic conditional hold + outbox event)',
  })
  async bookConsultation(
    @CurrentUser() user: RequestUser,
    @Body() dto: BookConsultationDto,
    @Headers('traceparent') traceparent?: string,
  ) {
    return this.consultationsService.bookConsultation(user.userId, dto, traceparent);
  }

  @Patch(':id/start')
  @Roles('doctor')
  @RateLimit('standard')
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique idempotency key',
    required: true,
  })
  @ApiOperation({ summary: 'Start consultation (CONFIRMED -> IN_PROGRESS, Doctor only)' })
  async startConsultation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.consultationsService.startConsultation(user.userId, id);
  }

  @Patch(':id/complete')
  @Roles('doctor')
  @RateLimit('standard')
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique idempotency key',
    required: true,
  })
  @ApiOperation({ summary: 'Complete consultation (IN_PROGRESS -> COMPLETED, Doctor only)' })
  async completeConsultation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto?: CompleteConsultationDto,
  ) {
    return this.consultationsService.completeConsultation(user.userId, id, dto);
  }

  @Patch(':id/cancel')
  @Roles('patient', 'doctor', 'admin')
  @RateLimit('standard')
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique idempotency key',
    required: true,
  })
  @ApiOperation({ summary: 'Cancel consultation (triggers refund if CONFIRMED)' })
  async cancelConsultation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: CancelConsultationDto,
  ) {
    return this.consultationsService.cancelConsultation(user.userId, user.role, id, dto.reason);
  }

  @Patch(':id/no-show')
  @Roles('doctor', 'admin')
  @RateLimit('standard')
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique idempotency key',
    required: true,
  })
  @ApiOperation({ summary: 'Mark patient as NO_SHOW (CONFIRMED -> NO_SHOW, Doctor or Admin)' })
  async markNoShow(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.consultationsService.markNoShow(user.userId, user.role, id);
  }

  @Get(':id')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Get consultation details (RBAC & ownership checked)' })
  async getConsultation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.consultationsService.getConsultationById(user.userId, user.role, id);
  }

  @Get()
  @Roles('patient')
  @RateLimit('standard')
  @ApiOperation({ summary: 'List consultations for current patient' })
  async listConsultations(@CurrentUser() user: RequestUser) {
    return this.consultationsService.listPatientConsultations(user.userId);
  }
}

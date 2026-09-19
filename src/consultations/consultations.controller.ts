import { Controller, Post, Get, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { ConsultationsService } from './consultations.service';
import { BookConsultationDto } from './dto/book-consultation.dto';
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
  @ApiOperation({
    summary: 'Book a consultation slot (Patient only, atomic conditional hold + outbox event)',
  })
  async bookConsultation(@CurrentUser() user: RequestUser, @Body() dto: BookConsultationDto) {
    return this.consultationsService.bookConsultation(user.userId, dto);
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

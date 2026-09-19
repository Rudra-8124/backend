import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { CreateSlotDto } from './dto/create-slot.dto';
import { BulkCreateSlotsDto } from './dto/bulk-create-slots.dto';
import { QuerySlotsDto } from './dto/query-slots.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';
import { DataSource } from 'typeorm';

@ApiTags('Availability')
@Controller('availability')
export class AvailabilityController {
  constructor(
    private readonly availabilityService: AvailabilityService,
    private readonly dataSource: DataSource,
  ) {}

  private async resolveDoctorId(userId: string): Promise<string> {
    const rows = await this.dataSource.query('SELECT id FROM doctors WHERE user_id = $1', [userId]);
    if (rows.length === 0) {
      throw new ForbiddenException('Only registered doctors can perform this action');
    }
    return rows[0].id;
  }

  @Post('slots')
  @ApiBearerAuth('access-token')
  @Roles('doctor')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Create a single discrete availability slot (Doctor only)' })
  async createSlot(@CurrentUser() user: RequestUser, @Body() dto: CreateSlotDto) {
    const doctorId = await this.resolveDoctorId(user.userId);
    return this.availabilityService.createSlot(doctorId, dto);
  }

  @Post('slots/bulk')
  @ApiBearerAuth('access-token')
  @Roles('doctor')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Bulk generate availability slots from weekly schedule (Doctor only)' })
  async bulkCreateSlots(@CurrentUser() user: RequestUser, @Body() dto: BulkCreateSlotsDto) {
    const doctorId = await this.resolveDoctorId(user.userId);
    return this.availabilityService.bulkCreateSlots(doctorId, dto);
  }

  @Delete('slots/:id')
  @ApiBearerAuth('access-token')
  @Roles('doctor')
  @HttpCode(HttpStatus.OK)
  @RateLimit('standard')
  @ApiOperation({ summary: 'Cancel an unbooked availability slot (Doctor only)' })
  async cancelSlot(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const doctorId = await this.resolveDoctorId(user.userId);
    return this.availabilityService.cancelSlot(doctorId, id);
  }

  @Public()
  @Get('doctors/:doctorId/slots')
  @RateLimit('relaxed')
  @ApiOperation({ summary: 'Get doctor availability slots (Public/Patient)' })
  async getDoctorSlots(@Param('doctorId') doctorId: string, @Query() query: QuerySlotsDto) {
    return this.availabilityService.getDoctorSlots(doctorId, query);
  }
}

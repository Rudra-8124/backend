import { Controller, Get, Patch, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';

@ApiTags('Users')
@Controller('users')
@ApiBearerAuth('access-token')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Get current user profile' })
  async getMe(@CurrentUser() user: RequestUser) {
    return this.usersService.findById(user.userId);
  }

  @Patch('me')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateMe(@CurrentUser() user: RequestUser, @Body() body: UpdateProfileDto) {
    return this.usersService.updateProfile(user.userId, body);
  }

  @Get(':id')
  @Roles('admin')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Get user by ID (admin only)' })
  async getUser(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Get()
  @Roles('admin')
  @RateLimit('standard')
  @ApiOperation({ summary: 'List users (admin only, keyset pagination)' })
  async listUsers(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.usersService.findAll(cursor, limit ? parseInt(limit, 10) : 20);
  }
}

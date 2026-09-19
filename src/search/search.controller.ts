import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';
import { SearchService, SearchDoctorsResponse } from './search.service';
import { SearchDoctorsDto } from './dto/search-doctors.dto';

@ApiTags('search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('doctors')
  @RateLimit('relaxed')
  @ApiOperation({
    summary: 'Search doctors with full-text, typo tolerance, multi-filter, and keyset pagination',
    description:
      'Queries verified doctors with full-text search over name/specialties/bio, trigram typo tolerance, filters for specialty, language, price, min rating, availability window, and opaque cursor pagination.',
  })
  @ApiResponse({ status: 200, description: 'List of matching doctors with next page cursor' })
  async searchDoctors(@Query() query: SearchDoctorsDto): Promise<SearchDoctorsResponse> {
    return this.searchService.searchDoctors(query);
  }
}

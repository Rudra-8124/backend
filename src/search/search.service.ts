import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CacheService } from '../common/cache/cache.service';
import { SearchDoctorsDto, DoctorSortOption } from './dto/search-doctors.dto';

export interface DoctorSearchResult {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  city: string | null;
  bio: string | null;
  licenseNumber: string;
  specializations: string[];
  languages: string[];
  experienceYears: number;
  feeCents: number;
  ratingAvg: number;
  ratingCount: number;
  isVerified: boolean;
  relevanceScore?: number;
}

export interface SearchDoctorsResponse {
  results: DoctorSearchResult[];
  next_cursor: string | null;
  cached: boolean;
}

interface CursorPayload {
  id: string;
  sortValue: number | string;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Search doctors with full-text, typo tolerance, filters, keyset pagination, and Redis cache-aside.
   */
  async searchDoctors(query: SearchDoctorsDto): Promise<SearchDoctorsResponse> {
    const { cached, data } = await this.cacheService.getOrSet<{
      results: DoctorSearchResult[];
      next_cursor: string | null;
    }>({
      namespace: 'search:doctors',
      identifier: query as unknown as Record<string, unknown>,
      ttlSeconds: 300,
      jitterSeconds: 30,
      fetcher: () => this.executeSearchQuery(query),
    });

    return {
      results: data.results,
      next_cursor: data.next_cursor,
      cached,
    };
  }

  /**
   * Directly executes parameterized search query against PostgreSQL.
   */
  async executeSearchQuery(
    query: SearchDoctorsDto,
  ): Promise<{ results: DoctorSearchResult[]; next_cursor: string | null }> {
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const sortBy =
      query.sort_by || (query.q ? DoctorSortOption.RELEVANCE : DoctorSortOption.RATING_DESC);

    const params: any[] = [];
    const whereClauses: string[] = ['d.is_verified = true', 'u.is_active = true'];

    let relevanceExpr = '0.0';
    if (query.q && query.q.trim().length > 0) {
      params.push(query.q.trim());
      const qIdx = params.length;

      relevanceExpr = `(
        CASE WHEN plainto_tsquery('english', $${qIdx})::text != ''
             THEN ts_rank(d.search_vector, plainto_tsquery('english', $${qIdx})) * 3.0
             ELSE 0.0 END +
        similarity(p.first_name || ' ' || p.last_name, $${qIdx}) * 2.0 +
        similarity(coalesce(d.bio, ''), $${qIdx})
      )`;

      whereClauses.push(`(
        (plainto_tsquery('english', $${qIdx})::text != '' AND d.search_vector @@ plainto_tsquery('english', $${qIdx})) OR
        similarity(p.first_name || ' ' || p.last_name, $${qIdx}) > 0.15 OR
        similarity(coalesce(d.bio, ''), $${qIdx}) > 0.15
      )`);
    }

    if (query.city && query.city.trim().length > 0) {
      params.push(query.city.trim());
      whereClauses.push(`p.city ILIKE $${params.length}`);
    }

    if (query.specialty && query.specialty.trim().length > 0) {
      params.push(query.specialty.trim());
      whereClauses.push(`$${params.length} = ANY(d.specializations)`);
    }

    if (query.language && query.language.trim().length > 0) {
      params.push(query.language.trim());
      whereClauses.push(`$${params.length} = ANY(d.languages)`);
    }

    if (query.min_price !== undefined) {
      params.push(query.min_price);
      whereClauses.push(`d.fee_cents >= $${params.length}`);
    }

    if (query.max_price !== undefined) {
      params.push(query.max_price);
      whereClauses.push(`d.fee_cents <= $${params.length}`);
    }

    if (query.min_rating !== undefined) {
      params.push(query.min_rating);
      whereClauses.push(`d.rating_avg >= $${params.length}`);
    }

    if (query.available_from || query.available_to) {
      const fromParam = query.available_from ? new Date(query.available_from) : new Date();
      params.push(fromParam);
      const fromIdx = params.length;

      let slotCondition = `s.start_time >= $${fromIdx}`;
      if (query.available_to) {
        params.push(new Date(query.available_to));
        slotCondition += ` AND s.end_time <= $${params.length}`;
      }

      whereClauses.push(`EXISTS (
        SELECT 1 FROM availability_slots s
        WHERE s.doctor_id = d.id
          AND s.status = 'AVAILABLE'
          AND ${slotCondition}
      )`);
    }

    // Keyset pagination cursor
    let decodedCursor: CursorPayload | null = null;
    if (query.cursor) {
      try {
        decodedCursor = JSON.parse(Buffer.from(query.cursor, 'base64').toString('utf-8'));
      } catch {
        // Invalid cursor ignored
      }
    }

    if (decodedCursor && decodedCursor.id && decodedCursor.sortValue !== undefined) {
      params.push(decodedCursor.sortValue);
      const valIdx = params.length;
      params.push(decodedCursor.id);
      const idIdx = params.length;

      switch (sortBy) {
        case DoctorSortOption.PRICE_ASC:
          whereClauses.push(
            `(d.fee_cents > $${valIdx} OR (d.fee_cents = $${valIdx} AND d.id > $${idIdx}))`,
          );
          break;
        case DoctorSortOption.PRICE_DESC:
          whereClauses.push(
            `(d.fee_cents < $${valIdx} OR (d.fee_cents = $${valIdx} AND d.id > $${idIdx}))`,
          );
          break;
        case DoctorSortOption.EXPERIENCE_DESC:
          whereClauses.push(
            `(d.experience_years < $${valIdx} OR (d.experience_years = $${valIdx} AND d.id > $${idIdx}))`,
          );
          break;
        case DoctorSortOption.RELEVANCE:
          whereClauses.push(
            `(${relevanceExpr} < $${valIdx} OR (${relevanceExpr} = $${valIdx} AND d.id > $${idIdx}))`,
          );
          break;
        case DoctorSortOption.RATING_DESC:
        default:
          whereClauses.push(
            `(d.rating_avg < $${valIdx} OR (d.rating_avg = $${valIdx} AND d.id > $${idIdx}))`,
          );
          break;
      }
    }

    // Determine ORDER BY clause
    let orderByClause: string;
    switch (sortBy) {
      case DoctorSortOption.PRICE_ASC:
        orderByClause = 'd.fee_cents ASC, d.id ASC';
        break;
      case DoctorSortOption.PRICE_DESC:
        orderByClause = 'd.fee_cents DESC, d.id ASC';
        break;
      case DoctorSortOption.EXPERIENCE_DESC:
        orderByClause = 'd.experience_years DESC, d.id ASC';
        break;
      case DoctorSortOption.RELEVANCE:
        orderByClause = 'relevance_score DESC, d.id ASC';
        break;
      case DoctorSortOption.RATING_DESC:
      default:
        orderByClause = 'd.rating_avg DESC, d.id ASC';
        break;
    }

    params.push(limit + 1);
    const limitIdx = params.length;

    const sql = `
      SELECT
        d.id,
        d.user_id AS "userId",
        p.first_name AS "firstName",
        p.last_name AS "lastName",
        (p.first_name || ' ' || p.last_name) AS "fullName",
        p.city,
        d.bio,
        d.license_number AS "licenseNumber",
        d.specializations,
        d.languages,
        d.experience_years AS "experienceYears",
        d.fee_cents AS "feeCents",
        d.rating_avg AS "ratingAvg",
        d.rating_count AS "ratingCount",
        d.is_verified AS "isVerified",
        ${relevanceExpr} AS "relevanceScore",
        ${relevanceExpr} AS relevance_score
      FROM doctors d
      JOIN profiles p ON p.user_id = d.user_id
      JOIN users u ON u.id = d.user_id
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${orderByClause}
      LIMIT $${limitIdx}
    `;

    const rows = await this.dataSource.query(sql, params);

    let next_cursor: string | null = null;
    const hasNextPage = rows.length > limit;
    const results = hasNextPage ? rows.slice(0, limit) : rows;

    if (hasNextPage) {
      const lastItem = results[results.length - 1];
      let sortValue: number | string;
      switch (sortBy) {
        case DoctorSortOption.PRICE_ASC:
        case DoctorSortOption.PRICE_DESC:
          sortValue = lastItem.feeCents;
          break;
        case DoctorSortOption.EXPERIENCE_DESC:
          sortValue = lastItem.experienceYears;
          break;
        case DoctorSortOption.RELEVANCE:
          sortValue = parseFloat(lastItem.relevanceScore || 0);
          break;
        case DoctorSortOption.RATING_DESC:
        default:
          sortValue = parseFloat(lastItem.ratingAvg || 0);
          break;
      }

      const cursorObj: CursorPayload = { id: lastItem.id, sortValue };
      next_cursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');
    }

    return { results, next_cursor };
  }
}

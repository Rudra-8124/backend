import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest<any>();
    const res = http.getResponse<any>();

    // Skip measuring metrics scrape itself to avoid self-reinforcing measurement loops
    if (req.url?.startsWith('/metrics')) {
      return next.handle();
    }

    const startTime = process.hrtime.bigint();
    const method = req.method || 'GET';

    return next.handle().pipe(
      tap(() => {
        const endTime = process.hrtime.bigint();
        const durationSeconds = Number(endTime - startTime) / 1e9;
        const routeTemplate = req.routeOptions?.url || req.routerPath;
        const route = this.metricsService.normalizeRoute(req.url, routeTemplate);
        const statusCode = res.statusCode || 200;

        this.metricsService.recordHttpRequest(method, route, statusCode, durationSeconds);
      }),
      catchError((err: unknown) => {
        const endTime = process.hrtime.bigint();
        const durationSeconds = Number(endTime - startTime) / 1e9;
        const routeTemplate = req.routeOptions?.url || req.routerPath;
        const route = this.metricsService.normalizeRoute(req.url, routeTemplate);
        const statusCode = err instanceof HttpException ? err.getStatus() : 500;

        this.metricsService.recordHttpRequest(method, route, statusCode, durationSeconds);
        throw err;
      }),
    );
  }
}

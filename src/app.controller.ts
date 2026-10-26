import { Body, Catch, ArgumentsHost, Controller, ExceptionFilter, Get, Headers, HttpException, HttpStatus, Param, Post, Put, Delete, UseFilters } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { StoreService } from './store.service';

class ItemDto { @IsInt() productId!: number; @IsInt() @Min(1) @Max(100) quantity!: number; }
class UpdateItemDto { @IsInt() @Min(1) @Max(100) quantity!: number; }
class CheckoutDto { @IsOptional() @IsString() couponCode?: string; }

@Catch()
class ApiErrorFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (typeof exception?.status === 'number' && typeof exception?.code === 'string') {
      response.status(exception.status).json({ error: { code: exception.code, message: exception.message, ...(exception.details ? { details: exception.details } : {}) } }); return;
    }
    if (exception instanceof HttpException) { response.status(exception.getStatus()).json({ error: { code: 'HTTP_ERROR', message: exception.message } }); return; }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  }
}

@Controller()
@UseFilters(new ApiErrorFilter())
export class AppController {
  constructor(private readonly store: StoreService) { }
  @Get('health') health() { return { status: 'ok' }; }
  @Get('products') products() { return this.store.listProducts(); }
  @Post('carts') createCart() { return this.store.createCart(); }
  @Get('carts/:id') getCart(@Param('id') id: string) { return this.store.getCart(id); }
  @Post('carts/:id/items') addItem(@Param('id') id: string, @Body() body: ItemDto) { return this.store.addItem(id, body.productId, body.quantity); }
  @Put('carts/:id/items/:productId') updateItem(@Param('id') id: string, @Param('productId') productId: string, @Body() body: UpdateItemDto) { return this.store.updateItem(id, Number(productId), body.quantity); }
  @Delete('carts/:id/items/:productId') removeItem(@Param('id') id: string, @Param('productId') productId: string) { return this.store.removeItem(id, Number(productId)); }
  @Post('carts/:id/checkout') checkout(@Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: CheckoutDto) { return this.store.checkout(id, key, body.couponCode); }
  @Get('orders/:id') order(@Param('id') id: string) { return this.store.getOrder(id); }
  // ADMIN endpoint: authentication is intentionally not implemented for this assignment.
  @Post('admin/coupons/generate') generateCoupon() { return this.store.generateCoupon(); }
  // ADMIN endpoint: read-only report.
  @Get('admin/report') report() { return this.store.report(); }
}

import { Module } from '@nestjs/common';
import { StoreService } from './store.service';
import { AppController } from './app.controller';
@Module({ controllers: [AppController], providers: [StoreService] })
export class AppModule {}

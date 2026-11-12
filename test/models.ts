import { User } from '@ghuri/auth'
import { AppConfig } from '@ghuri/core'
import {
  BooleanField,
  CASCADE,
  CharField,
  DateTimeField,
  DecimalField,
  ForeignKey,
  type Manager,
  Model,
  type ModelClass,
  TextField,
} from '@ghuri/orm'

const user = () => User as unknown as ModelClass

export class Order extends Model({
  number: new CharField({ maxLength: 20, unique: true, helpText: 'Order number' }),
  customer: new ForeignKey(user, { onDelete: CASCADE, relatedName: 'orders' }),
  total: new DecimalField({ maxDigits: 8, decimalPlaces: 2 }),
  status: new CharField({
    maxLength: 10,
    choices: [
      ['open', 'Open'],
      ['shipped', 'Shipped'],
      ['refunded', 'Refunded'],
    ],
    default: 'open',
  }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Order>
  static Meta = { appLabel: 'shop', ordering: ['id'] }
}

export class Ticket extends Model({
  subject: new CharField({ maxLength: 100 }),
  body: new TextField({ blank: true }),
  author: new ForeignKey(user, { onDelete: CASCADE, relatedName: 'tickets' }),
  closed: new BooleanField({ default: false }),
}) {
  declare static objects: Manager<Ticket>
  static Meta = { appLabel: 'shop', ordering: ['id'] }
}

export class Note extends Model({
  title: new CharField({ maxLength: 100 }),
  owner: new ForeignKey(user, { onDelete: CASCADE, relatedName: 'notes', null: true, blank: true }),
}) {
  declare static objects: Manager<Note>
  static Meta = { appLabel: 'shop', ordering: ['id'] }
}

export class ShopConfig extends AppConfig {
  name = 'shop'
  override models = { Order, Ticket, Note }
}

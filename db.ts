// Sequelize ORM setup for SQLite
import { Sequelize, DataTypes, Model, Optional } from 'sequelize';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './botdata.sqlite',
  logging: false
});

// Config table
export interface ConfigAttributes {
  key: string;
  value: string;
}

export class Config extends Model<ConfigAttributes> implements ConfigAttributes {
  public key!: string;
  public value!: string;
}

Config.init(
  {
    key: {
      type: DataTypes.STRING,
      primaryKey: true,
    },
    value: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  { sequelize, tableName: 'config', timestamps: false }
);

// User table
export interface UserAttributes {
  id: number;
  name: string;
  last_action_timestamp: number;
  last_action_status: string;
  is_in_oc: boolean;
  not_in_oc_since?: number | null;
  fuckup_tally?: number;
}

export class User extends Model<UserAttributes> implements UserAttributes {
  public id!: number;
  public name!: string;
  public last_action_timestamp!: number;
  public last_action_status!: string;
  public is_in_oc!: boolean;
  public not_in_oc_since?: number | null;
  public fuckup_tally?: number;
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    last_action_timestamp: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    last_action_status: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    is_in_oc: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    not_in_oc_since: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    fuckup_tally: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
  },
  { sequelize, tableName: 'users', timestamps: false }
);

// Alerts table
export interface AlertAttributes {
  user_id: number;
  last_alert: number;
}

export class Alert extends Model<AlertAttributes> implements AlertAttributes {
  public user_id!: number;
  public last_alert!: number;
}

Alert.init(
  {
    user_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    last_alert: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  { sequelize, tableName: 'alerts', timestamps: false }
);

// Sync tables
export async function syncDb() {
  await sequelize.sync();
}

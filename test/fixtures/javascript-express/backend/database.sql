-- A hand-maintained schema dump, the only table/column metadata this whole app has. Committed as
-- part of the G6 Phase 2 investigation (see D-javascript-express-adapter in DECISIONS.md): it is a
-- per-app habit, not a framework convention -- nothing at runtime reads it, nothing enforces that
-- it still matches the live database, and there is no `mysql2` equivalent of Alembic's version
-- table or TypeORM's entity metadata to check it against. Two details below are exactly why a
-- schema-file-driven heuristic still could not gate codegen safely:
--   * `user.user_uid` is CHAR(36) (UUID-shaped) but `order.order_id` is BIGINT AUTO_INCREMENT --
--     "does this resource have a UUID primary key" genuinely varies table to table, and NOTHING in
--     the controller SQL (`WHERE order_id = ?`) reveals which one you are looking at.
--   * `user.password_hash` and `user.phone_e164` exist here. A schema file enumerates what EXISTS;
--     it never says what is safe to expose.

CREATE TABLE `user` (
  `user_uid` CHAR(36) NOT NULL,
  `nickname` VARCHAR(64) NOT NULL,
  `profile_image_url` VARCHAR(512) DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `phone_e164` VARCHAR(32) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT NULL,
  `deleted_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`user_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `order` (
  `order_id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_uid` CHAR(36) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `total_amount` DECIMAL(12,2) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`order_id`),
  CONSTRAINT `fk_order_user` FOREIGN KEY (`user_uid`) REFERENCES `user` (`user_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

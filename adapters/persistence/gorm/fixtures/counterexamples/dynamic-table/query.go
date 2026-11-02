package dynamictable

import "gorm.io/gorm"

type User struct {
    ID uint64
}

// Table selection is request/runtime data, not a static property of User.
func findUsers(db *gorm.DB, tableName string, users *[]User) error {
    return db.Table(tableName).Find(users).Error
}

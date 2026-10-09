ActiveRecord::Schema[8.1].define(version: 2) do
  create_table "teams", force: :cascade do |t|
    t.string "name", null: false
  end

  create_table "heroes", force: :cascade do |t|
    t.string "name", null: false
    t.string "nickname"
  end
end

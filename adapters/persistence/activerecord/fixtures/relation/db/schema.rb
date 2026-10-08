ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "teams", force: :cascade do |t|
    t.string "name", null: false
  end

  create_table "heroes", force: :cascade do |t|
    t.string "name", null: false
    t.integer "team_id"
  end

  add_foreign_key "heroes", "teams"
end

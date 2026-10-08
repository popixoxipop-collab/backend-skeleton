ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "heroes", force: :cascade do |t|
    t.string "name", null: false
    t.string "secret_name"
  end
end

# Offline oracle for the activerecord scope record.
#
# Loads one fixture directory (db/schema.rb and app/models/**/*.rb) into an in-memory SQLite database
# with ActiveRecord and prints, as JSON on stdout, the physical schema facts ActiveRecord reports for the
# model classes the fixture defines (tables, columns, primary keys, foreign keys), plus the versions of
# the runtime and libraries that produced them. No file or network database is opened.
require "digest"
require "json"
require "pathname"
require "active_record"
require "sqlite3"

# sha256 of this script and of every file the fixture argument names (the file, or every file under a directory), keyed by the path as given.
def input_digests(script, target)
  names = File.directory?(target) ? Dir.glob(File.join(target, "**", "*"), File::FNM_DOTMATCH).select { |name| File.file?(name) } : [target]
  ([script] + names).to_h { |name| [Pathname.new(name).cleanpath.to_s, Digest::SHA256.file(name).hexdigest] }.sort.to_h
end

consumed = input_digests($PROGRAM_NAME, ARGV.fetch(0)) # before the fixture is loaded
root = File.expand_path(ARGV.fetch(0))
ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Migration.verbose = false
load File.join(root, "db", "schema.rb")
Dir[File.join(root, "app", "models", "**", "*.rb")].sort.each { |file| require file }

connection = ActiveRecord::Base.connection
models = ActiveRecord::Base.descendants.reject { |model| model.abstract_class? || model.name.nil? || model.name.start_with?("ActiveRecord::") }
tables = []
columns = []
primary_keys = []
foreign_keys = []
unmodeled = []
models.each do |model|
  table = model.table_name
  tables << table
  columns.concat(model.column_names.map { |name| "#{table}.#{name}" })
  keys = Array(model.primary_key)
  primary_keys << "#{table}(#{keys.join(',')})" unless keys.empty?
  connection.foreign_keys(table).each do |key|
    foreign_keys << "#{key.from_table}(#{Array(key.column).join(',')})->#{key.to_table}(#{Array(key.primary_key).join(',')})"
  end
  unmodeled << "create-index" unless connection.indexes(table).empty?
  unmodeled << "default-scope" unless model.default_scopes.empty?
end

result = {
  "facts" => {
    "columns" => columns.uniq.sort,
    "foreign_keys" => foreign_keys.uniq.sort,
    "primary_keys" => primary_keys.uniq.sort,
    "tables" => tables.uniq.sort,
    "unmodeled" => unmodeled.uniq.sort,
  },
  "inputs" => consumed,
  "oracle" => "activerecord-sqlite3-memory",
  "versions" => { "activerecord" => ActiveRecord.version.to_s, "ruby" => RUBY_VERSION, "sqlite3" => SQLite3::VERSION },
}
puts JSON.pretty_generate(result)

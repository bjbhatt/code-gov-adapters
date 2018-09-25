const _ = require("lodash");
const Bodybuilder = require("bodybuilder");



// MAy be deleted
const moment = require("moment");
const Utils = require("../../utils");
const Logger = require("../../utils/logger");
const repoMapping = require("../../indexes/repo/mapping.json");

const DATE_FORMAT = "YYYY-MM-DD";
const REPO_RESULT_SIZE_MAX = 10000;
const REPO_RESULT_SIZE_DEFAULT = 10;
const TERM_RESULT_SIZE_MAX = 100;
const TERM_RESULT_SIZE_DEFAULT = 5;
const ELASTICSEARCH_SORT_ORDERS = ['asc', 'desc'];
const ELASTICSEARCH_SORT_MODES = ['min', 'max', 'sum', 'avg', 'median'];
const searchPropsByType =
  Utils.getFlattenedMappingPropertiesByType(repoMapping["repo"]);

let logger = new Logger({name: "searcher"});

/**
 * Delete private object keys ( prefixed with `_` ) from objects in passed collection.
 * @param {Array[object]} collection - list of objects to have keys deleted
 */
function omitPrivateKeys(collection) {
  const omitFn = (value) => {
    if (value && typeof value === 'object') {
      Object.keys(value).forEach((key) => {
        if (key[0] === "_") {
          delete value[key];
        }
      });
    }
  };
  return _.cloneDeepWith(collection, omitFn);
}

/**
 * Parse the hits and source data from an Elasticsearch response object.
 * @param {object} response Elasticsearch reponse object.
 */
function parseResponse(response) {
  if(response.hasOwnProperty('hits') && response.hits.total > 0) {
    let repo = omitPrivateKeys(res.hits.hits[0]._source);
    return repo;
  }

  logger.debug("No hits", { es_result: JSON.stringify(response) });
  return {};

}

function createQueryBody(queryType, field, value) {
  let body = new Bodybuilder();

  body.query(queryType, field, value);
  let query = body.build("v2");
  logger.debug(query);

  return query;
}

function _addMatchPhraseForFullText(body, queryParams, field, boost) {
  let query = { "match_phrase": {} };
  query["match_phrase"][field] = {
    "query": queryParams.q
  };

  if (boost) {
    query["match_phrase"][field]["boost"] = boost;
  }

  body.query("bool", "should", query);
}

function _addMatchForFullText(body, queryParams, field) {
  let query = { "match": {} };
  query["match"][field] = queryParams.q;

  body.query("bool", "should", query);
}

function _addCommonCutoffForFullText(body, queryParams, field, boost) {
  let query = { "common": {} };
  query["common"][field] = {
    "query": queryParams.q,
    "cutoff_frequency": 0.001,
    "low_freq_operator": "and"
  };

  if (boost) {
    query["common"][field]["boost"] = boost;
  }

  body.query("bool", "should", query);
}

function _addFullTextQuery(body, searchQuery) {
  const searchFields = [
    "name^5",
    "name.keyword^10",
    "description^2",
    "agency.acronym",
    "agency.name",
    "agency.name.keyword^5",
    "permissions.usageType",
    "tags^3",
    "tags.keyword^3",
    "languages",
    "languages.keyword^3"
  ];

  body.query("multi_match", 'fields', searchFields, {"query": searchQuery}, {"type": "best_fields"});
}

function _addStringFilter(body, field, filter) {
  if (filter instanceof Array) {
    filter.forEach((filterElement) => {
      logger.info(filterElement);
      body.orFilter("term", `${field}.keyword`, filterElement.toLowerCase());
    });
  } else {
    body.filter("term", `${field}.keyword`, filter.toLowerCase());
  }
}

function _addStringFilters(body, queryParams) {

  searchPropsByType['keyword'].forEach((field) => {
    if(queryParams[field]) {
      _addStringFilter(body, field, queryParams[field]);
    }
  });
}

function _addDateRangeFilters(body, queryParams) {
  const _addRangeFilter = (field, lteRange, gteRange) => {
    let ranges = {};

    const _addRangeForRangeType = (rangeType, dateRange) => {
      if(dateRange) {
        dateRange = moment(dateRange);
        if(dateRange.isValid()) {
          ranges[rangeType] = dateRange.utc().format(DATE_FORMAT);
        } else {
          throw new Error(
            `Invalid date supplied for ${field}_${rangeType}. ` +
            `Please use format ${DATE_FORMAT} or ISO8601.`
          );
        }
      }
    };

    _addRangeForRangeType("lte", lteRange);
    _addRangeForRangeType("gte", gteRange);

    body.filter("range", field, ranges);
  };

  let possibleRangeProps = searchPropsByType["date"];
  possibleRangeProps.forEach((field) => {
    let lteRange = queryParams[field + "_lte"];
    let gteRange = queryParams[field + "_gte"];
    if(lteRange || gteRange) {
      _addRangeFilter(field, lteRange, gteRange);
    }
  });
}

function _addSizeFromParams(body, queryParams) {
  queryParams.size = queryParams.size || REPO_RESULT_SIZE_DEFAULT;
  let size = queryParams.size > REPO_RESULT_SIZE_MAX ? REPO_RESULT_SIZE_MAX : queryParams.size;
  let from = queryParams.from || 0;
  body.size(size);
  body.from(from);
}

function _addIncludeExclude(body, queryParams) {
  let include = queryParams.include || null;
  let exclude = queryParams.exclude || null;
  let _source = {};
  const _enforceArray = (obj) => {
    if (!(obj instanceof Array)) {
      if (typeof(obj) === "string") {
        return [obj];
      } else {
        return [];
      }
    } else {
      return obj;
    }
  };

  if (include) {
    _source.include = _enforceArray(include);
  }
  if(exclude) {
    _source.exclude = _enforceArray(exclude);
  }

  if(Object.keys(_source).length) {
    body.rawOption("_source", _source);
  }
}

/**
 * This adds all of our data field filters to a bodybuilder object
 *
 * @param {any} body An instance of a Bodybuilder class
 * @param {any} q The query parameters a user is searching for
 */
function _addFieldFilters(body, queryParams){
  _addStringFilters(body, queryParams);
  _addDateRangeFilters(body, queryParams);
}

/**
 * Adds sorting depending on query input parameters.
 *
 * @param {any} body An instance of a Bodybuilder class
 * @param {any} queryParams The query parameters a user is searching for
 */
function _addSortOrder(body, queryParams) {
  body.sort('_score', 'desc');
  body.sort('score', 'desc');

  if(queryParams['sort'] && (queryParams['sort'] !== 'asc' || queryParams['sort'] !== 'desc')) {
    const sortValues = [];
    queryParams.sort.split(',').forEach(value => {
      if(value) {
        sortValues.push(value.split('__'));
      }
    });

    sortValues.forEach(sortValue => {
      let sortOptions = {};
      let sortField = sortValue[0];

      if(sortValue.length > 1) {
        sortValue.slice(1).forEach(item => {
          if (ELASTICSEARCH_SORT_ORDERS.includes(item)) {
            sortOptions.order = item;
          }
          if (ELASTICSEARCH_SORT_MODES.includes(item)) {
            sortOptions.mode = item;
          }
        });
        body.sort(`${sortField}.keyword`, sortOptions);
      } else {
        body.sort(`${sortField}.keyword`, 'asc');
      }
    });
  }
}

function createSearchQuery(queryParams) {
  let body = new Bodybuilder();

  if(queryParams.q) {
    _addFullTextQuery(body, queryParams.q);
  }
  _addFieldFilters(body, queryParams);
  _addSizeFromParams(body, queryParams);

  _addIncludeExclude(body, queryParams);
  _addSortOrder(body, queryParams);

  let query = body.build("v2");

  logger.debug(query);
  return query;
}

// This gives me hives. It needs to be refactored
function searchTermsQuery(queryParams) {
  // TODO: use BodyBuilder more
  let body = new Bodybuilder();

  // add query terms (boost when phrase is matched)
  if (queryParams.term) {
    body.query("match", "term_suggest", queryParams.term);
    body.query("match_phrase", "term_suggest", { query: queryParams.term });
  }

  // set the term types (use defaults if not supplied)
  let termTypes = this.config.TERM_TYPES_TO_SEARCH;
  if (queryParams.term_type) {
    if (queryParams.term_type instanceof Array) {
      termTypes = queryParams.term_type;
    } else {
      termTypes = [queryParams.term_type];
    }
  }
  termTypes.forEach((termType) => {
    body.orFilter("term", "term_type", termType);
  });

  // build the query and add custom fields (that bodyparser can't handle)
  let functionQuery = body.build("v2");

  // boost exact match
  if (queryParams.term) {
    functionQuery.query.bool.should = {
      "match": {
        "term": queryParams.term
      }
    };
  }

  // add scoring function - is this really necessary?
  functionQuery.functions = [{
    "field_value_factor": {
      "field": "count_normalized",
      "factor": .25
    }
  }];
  functionQuery.boost_mode = "multiply";

  // set the size, from
  let size = queryParams.size || TERM_RESULT_SIZE_DEFAULT;
  size = size > TERM_RESULT_SIZE_MAX ? TERM_RESULT_SIZE_MAX : size;
  let from = queryParams.from ? queryParams.from : 0;

  // finalize the query
  let query = {
    "query": { "function_score": functionQuery },
    "size": size,
    "from": from
  };

  logger.debug(query);
  return query;
}

module.exports = {
  createQueryBody,
  createSearchQuery,
  omitPrivateKeys,
  parseResponse,
  searchTermsQuery,
  _addFullTextQuery,
  _addStringFilter,
  _addStringFilters,
  _addDateRangeFilters,
  _addSizeFromParams,
  _addIncludeExclude,
  _addFieldFilters,
  _addSortOrder,
  _addMatchPhraseForFullText,
  _addMatchForFullText,
  _addCommonCutoffForFullText
}